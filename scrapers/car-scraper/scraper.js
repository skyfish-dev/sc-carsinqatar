const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const https = require("https");
const url = require("url");

puppeteer.use(StealthPlugin());

async function scrapeQMotor() {
  // Get target cars from command line argument or environment variable
  const numCarsArg = process.argv[2];
  const envTargetCars = process.env.TARGET_CARS;
  let targetCars;
  
  if (numCarsArg) {
    targetCars = parseInt(numCarsArg) || 10;
  } else if (envTargetCars) {
    targetCars = parseInt(envTargetCars) || 10;
  } else {
    targetCars = 10; // Default for GitHub Actions
  }
  
  console.log(`\n✅ Target set to ${targetCars} cars`);
  console.log("🚀 Starting scraper...\n");

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-ipc-flooding-protection",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=TranslateUI"
    ],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  let currentPage = 1;
  let allCarLinks = [];

  // Keep scraping pages until we have enough car links
  while (allCarLinks.length < targetCars) {
    const pageSuffix = currentPage > 1 ? `?page=${currentPage}` : '';
    const url = `https://qmotor.com/cars${pageSuffix}`;
    console.log(`\n📄 Scraping page ${currentPage}: ${url}`);

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Scroll to load lazy content
      await autoScroll(page);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if there are listings
      const priceEls = await page.$$('p.price');
      if (priceEls.length === 0) {
        console.log(`❌ No cars found on page ${currentPage}`);
        break;
      }

      // Extract car data from this page
      const pageCars = await page.evaluate(() => {
        const priceEls = document.querySelectorAll('p.price');
        const wrappers = Array.from(priceEls).map(price => price.parentElement.parentElement.parentElement);
        const items = [];

        wrappers.forEach((wrapper) => {
          try {
            const title = wrapper.querySelector('h3.cardTitle')?.innerText.trim() || '';
            const price = wrapper.querySelector('p.price')?.innerText?.trim() || '';
            const year = wrapper.querySelector('p.year')?.innerText?.trim() || '';
            const mileage = wrapper.querySelector('p.kilometers')?.innerText?.trim() || '';
            const viewsEl = wrapper.querySelector('.noViews p');
            const views = parseInt(viewsEl?.innerText?.trim() || '0') || 0;

            const linkEl = wrapper.querySelector('a') || wrapper.closest('a');
            const url = linkEl ? 'https://qmotor.com' + linkEl.getAttribute('href') : '';

            items.push({ title, price, year, mileage, url, phone: '', views, vehicleImages: '' });
          } catch (err) {
            // Skip malformed listings
          }
        });

        return items;
      });

      console.log(`   ✓ Found ${pageCars.length} cars on page ${currentPage}`);

      if (pageCars.length === 0) {
        console.log(`❌ No cars found on page ${currentPage}, stopping pagination`);
        break;
      }

      allCarLinks.push(...pageCars);
      console.log(`   📊 Total collected: ${allCarLinks.length}/${targetCars} car links`);

      // Stop if we've collected enough
      if (allCarLinks.length >= targetCars) {
        console.log(`\n✅ Collected enough car links (${allCarLinks.length})`);
        break;
      }

      // Check if next page button exists
      const nextButton = await page.$('.ant-pagination-item-link[title="Next Page"]');
      if (!nextButton) {
        console.log(`❌ No next page button found on page ${currentPage}`);
        break;
      }

      currentPage++;

      // Small delay between page navigations
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (err) {
      console.error(`❌ Error on page ${currentPage}:`, err.message);
      break;
    }
  }

  // Scrape details from each detail page
  console.log('\n🔗 Now scraping details from each listing page...');
  const scrapedCars = [];
  
  for (let i = 0; i < targetCars && i < allCarLinks.length; i++) {
    const car = allCarLinks[i];
    console.log(`   [${i + 1}/${targetCars}] Scraping: ${car.title}`);
    
    if (!car.url) {
      scrapedCars.push(car);
      continue;
    }

    try {
      await page.goto(car.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Scroll to load lazy content
      await autoScroll(page);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Click on Contact Seller to expand and reveal phone number
      try {
        const contactButton = await page.$('.greyHolder .headerSec');
        if (contactButton) {
          await contactButton.click();
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      } catch (err) {
        // Contact section may not exist
      }

      const details = await page.evaluate(() => {
        // Extract phone number from Contact Seller section
        let phone = '';
        const phoneEl = document.querySelector('.contactDetails a[href^="tel:"]');
        if (phoneEl?.href) {
          phone = phoneEl.href.replace('tel:', '').replace(/^\+{2,}/, '+').replace(/\s+/g, '').trim();
        }

        // Extract vehicle images from modern-gallery
        let vehicleImages = '';
        const galleryContainer = document.querySelector('.modern-gallery');
        if (galleryContainer) {
          vehicleImages = Array.from(galleryContainer.querySelectorAll('.gallery-item[data-src]'))
            .map(item => item.getAttribute('data-src'))
            .filter(src => src)
            .join('|');
        }

        // Extract views
        let views = 0;
        const viewsSelectors = ['.noViews p', '[class*="views"] p'];
        for (const selector of viewsSelectors) {
          const viewsEl = document.querySelector(selector);
          if (viewsEl?.innerText) {
            views = parseInt(viewsEl.innerText.replace(/\D/g, '') || '0', 10);
            if (views > 0) break;
          }
        }

        return { phone, vehicleImages, views };
      });

      car.phone = details.phone;
      car.vehicleImages = details.vehicleImages;
      car.views = details.views;

    } catch (err) {
      console.error(`   ❌ Error scraping ${car.title}:`, err.message);
    }

    scrapedCars.push(car);
    await new Promise(resolve => setTimeout(resolve, 800)); // Delay between requests
  }

  // Trim to target
  const finalCars = scrapedCars.slice(0, targetCars);
  console.log(`\n✅ Successfully scraped ${finalCars.length} cars`);

  // Upload to Google Sheets
  console.log("📊 Uploading to Google Sheets...");
  try {
    await uploadToGoogleSheets(finalCars);
    console.log("✅ Successfully updated Google Sheets!");
  } catch (err) {
    console.error("❌ Failed to upload to Google Sheets:", err.message);
    throw err; // Re-throw to fail the GitHub Action
  }

  // Send Discord notification
  try {
    await sendDiscordNotification(finalCars.length);
  } catch (err) {
    console.error('❌ Discord notification failed:', err.message);
    // Don't fail the action for Discord notification failure
  }

  await browser.close();
}

async function uploadToGoogleSheets(cars) {
  const { google } = require('googleapis');

  // Get spreadsheet ID from environment variable
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEETS_ID environment variable is required');
  }

  // Get Google service account credentials from environment variable
  const googleCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!googleCredentials) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is required');
  }

  let credentials;
  try {
    credentials = JSON.parse(googleCredentials);
  } catch (err) {
    throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_KEY format: must be valid JSON');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Prepare headers
  const headers = [
    'Title', 'Vehicle Images', 'Price', 'Year', 'Mileage', 'Phone', 'Views', 'Vehicle URL'
  ];

  // Prepare rows
  const rows = cars.map(car => [
    car.title || '',
    car.vehicleImages || '',
    (car.price || '').replace('QR ', '').trim(), // Remove "QR " prefix
    car.year || '',
    car.mileage || '',
    car.phone || '',
    car.views || 0,
    car.url || ''
  ]);

  // Clear existing data
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'A1:Z',
    });
  } catch (err) {
    console.log('⚠️ Could not clear sheet (might be empty)');
  }

  // Write new data
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'A1',
    valueInputOption: 'RAW',
    resource: {
      values: [headers, ...rows],
    },
  });
}

async function sendDiscordNotification(count) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('⚠️ Discord webhook URL not provided, skipping notification');
    return;
  }

  const message = `${count} items from Qmotor pushed successfully`;

  const postData = JSON.stringify({ content: message });

  const parsedUrl = url.parse(webhookUrl);

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        console.log('🔔 Discord notification sent');
        resolve();
      });
    });
    req.on('error', (err) => {
      console.error('❌ Failed to send Discord notification:', err.message);
      reject(err);
    });
    req.write(postData);
    req.end();
  });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

// Run the scraper
scrapeQMotor().catch(console.error);
