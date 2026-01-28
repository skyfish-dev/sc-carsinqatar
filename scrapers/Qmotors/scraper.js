const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const readline = require("readline");
const https = require("https");
const url = require("url");

puppeteer.use(StealthPlugin());

// Ask user for input
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, answer => {
    rl.close();
    resolve(answer);
  }));
}

async function scrapeQMotor() {
  const numCarsArg = process.argv[2];
  let targetCars;
  if (numCarsArg) {
    targetCars = parseInt(numCarsArg) || 10;
  } else {
    const targetStr = await askQuestion("\n🎯 How many cars do you want to scrape? ");
    targetCars = parseInt(targetStr) || 10;
  }
  console.log(`\n✅ Target set to ${targetCars} cars`);
  console.log("🚀 Starting scraper...\n");

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage"
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
  }

  // Send Discord notification
  try {
    await sendDiscordNotification(finalCars.length);
  } catch (err) {
    console.error('❌ Discord notification failed:', err.message);
  }

  await browser.close();
}

async function uploadToGoogleSheets(cars) {
  const { google } = require('googleapis');

  // Load from config
  const { spreadsheetId } = require('./sheet-config.json');

  // Hardcoded credentials
  const credentials = {
    "type": "service_account",
    "project_id": "fleet-petal-469606-p4",
    "private_key_id": "b867cb0bda0a65b7c649bb56aefc98399164fa08",
    "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDnwxKXKPKRE2FF\noqddnoutu7jT+ye1q5qjkEKLrw67NNv/zBb28vTEoj5GIPEYSG6Mg11mMySp7AGB\nrguecB6rTa0vDM/7nn0lAU+WiqZjdtULMgK07TvPcnxr2ikvKQdHDfZ5Rl4gQNOF\nEgPmGC0X21WF7HZBYfPKU9gmDZp4G5oHmb8P9RxW1T8PBdKgCWxGg0/hExd0XAj8\nOZPnPltMgL32nlEhNWWvfi1rqWfxdN27jfDYHneF7HXTwTFJi9XI22N7GaOWZIHC\nX9zMA9e543MmkY0M0d4AtmX6PueNOJXcVN+B/PIYhNcqjsljQFO9kjagCLUbQ0gU\nvv+tF5wXAgMBAAECggEADIrZwGhDZFPuEWfH8sDIFcSRScuPe30h3WGXvSZ7cujD\n65Grpn0OGQjsuzym8r9f8c1dw+oKcGjoySm80Dvu6CqU4w7bv8xbQNVToM9R40a3\n9do+Tw6A2ToWMkhre479XIkmNXiRuUe414lBJvXxyGPWB4bjlkGktDNNNC+YesQG\n2JMOIy3dNJDJACC20KYYdOUsPYqxqwZv3O9EwajMksB6mXF5m1wj/JIhgyAvLNDE\nqBQYCXKFUeOLR3OFfPMCanTkHCVWD22hRx0eL2X+H+862rPe86S3u0hog0nwNrdg\n48lTXO9f8dvr/r8+VUrTZ/EspgHw9BL8EqvtnEMneQKBgQD+nD852GEb7MjxrwHL\nDnLLTBv8KWG9U/gOUJERoMORC37TEe4pSQgTMe/QvaJyRYVjN4bjbhwjPlpULBAF\n8dde55lTcl8zN2yQjPXnldLs10C977+1a1GeKT6L8w0CM6QBhTMl0Os8ZknNtR9l\nYyLc4dX0yDshgOnnJpTzAPSBuQKBgQDpBuaiiLceQimF58NgA2S7BXHroh2irEvV\n/ab1KW407pTmlv0JtPUExg82HCx8YXjAiLGl7yerkN1hlcM3+A1viNKprF0cLQN7\nu6ASNILKE99nlvRA8oSLvvIhuXfQ9mCHudJwhMblmXfYMOl9yaa1AA7CZX4ft5nR\nPO0/Hpo0TwKBgFta/sinnfhiFpu5WqBcN85AKc5pnrtLFLc2K0cy8tjpUgEz7st7\ne90/TrgMQuxTi4/VDZ4vFQOETO7kvH8VjlxsJzSs1gHPgjG/kkAdHwiCF6XPD29t\n6WQhkmKuu90tYEx3WanY837BiPu5YGGFl62/joB9E9JqqgKZclpa3mBpAoGAU4eJ\nvNFM8qe8wqclPZF51iBJibF+9gTU2kwmQNMtEgRDk7Sj14rqGV/1q+vFdoBqDHnz\nVAu6KKGw+X35kGJ2Tni5KuECL0tjaEMFSgFQsKcW+cb+nxlPsdgsazJUZK8sQvq1\nGGg/86VjdDd0OwbBnzf6EmzXHP9vP7WbRXjuxbkCgYEAo6lwhYROVprIdTBEfGT/\nm6JLoNCVh5GAcJyd2mWYBaxu1nbHWmkfqcG7A8+VVN2GBObzaFQ9RAUSk8yyHPuZ\ndmC35VdDBF1nOrrCnte46jkNLEHuL6WEh6VwJBhG4Vg1yQmHNug/ydA43uuf82Wq\niVDaive9Ljs8CET3FpKHnHI=\n-----END PRIVATE KEY-----\n",
    "client_email": "carslaepushtosheet@fleet-petal-469606-p4.iam.gserviceaccount.com",
    "client_id": "114547508604922002943",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/carslaepushtosheet%40fleet-petal-469606-p4.iam.gserviceaccount.com",
    "universe_domain": "googleapis.com"
  };

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
  const webhookUrl = 'https://discord.com/api/webhooks/1430798084702470216/VhcKDrQVPNdunBSIJpBrgyIUJSfeY9twMSxSYljSWGdN1VD3M8fkgKjYNrmczjn9rH9v';
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

scrapeQMotor().catch(console.error);
