const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const readline = require("readline");
const https = require("https");
const url = require("url");

puppeteer.use(StealthPlugin());

// Retry with exponential backoff
async function retryWithBackoff(fn, maxRetries = 5, operation = "operation") {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isLastRetry = i === maxRetries - 1;
      if (isLastRetry) {
        throw err;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const waitTime = Math.min(1000 * Math.pow(2, i), 16000);
      console.log(`      ⚠️ ${operation} failed, retrying in ${waitTime/1000}s... (${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// Ask user for input
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function scrapeQicMarket() {
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
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-gpu"
    ],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  let currentPage = 1;
  let allCarLinks = [];

  // Keep scraping pages until we have enough car URLs
  while (allCarLinks.length < targetCars) {
    const pageUrl = currentPage === 1 ? 'https://qic.online/en/market/cars/used' : `https://qic.online/en/market/cars/used?page=${currentPage}`;
    console.log(`\n📄 Scraping page ${currentPage}: ${pageUrl}`);

    try {
      await retryWithBackoff(
        () => page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: 120000,
        }),
        3,
        "page navigation"
      );

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Scroll to load lazy content
      await autoScroll(page);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Extract car links from this page
      const pageCarLinks = await page.evaluate(() => {
        const items = [];

        const carCards = document.querySelectorAll('.car-card');
        carCards.forEach((card) => {
          try {
            // Find the image container link for URL
            const imageLink = card.querySelector('.car-card__image-container');
            const url = imageLink ? imageLink.href : '';

            // Title
            const titleEl = card.querySelector('h3.car-card__title');
            const title = titleEl ? titleEl.innerText.trim() : '';

            // Price
            const priceEl = card.querySelector('span[dir="ltr"]');
            const price = priceEl ? priceEl.innerText.trim() : '';

            // Details (year and mileage)
            const detailEls = card.querySelectorAll('.car-card__detail');
            const year = detailEls.length > 0 ? detailEls[0].innerText.trim() : '';
            const mileage = detailEls.length > 1 ? detailEls[1].innerText.trim() : '';

            if (url && title) {
              items.push({
                title,
                price,
                priceValue: price.replace('QAR‎', '').trim(),
                priceCurrency: 'QAR',
                year,
                mileage,
                url
              });
            }
          } catch (err) {
            console.error('Error extracting car card:', err.message);
          }
        });

        return items;
      });

      console.log(`   ✓ Found ${pageCarLinks.length} cars on page ${currentPage}`);

      if (pageCarLinks.length === 0) {
        console.log(`❌ No cars found on page ${currentPage}, stopping`);
        break;
      }

      allCarLinks.push(...pageCarLinks);
      console.log(`   📊 Total collected: ${allCarLinks.length}/${targetCars} cars`);

      // Stop if we've collected enough URLs
      if (allCarLinks.length >= targetCars) {
        console.log(`\n✅ Collected enough car URLs (${allCarLinks.length})`);
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

  // Limit to target number
  const carsToScrape = allCarLinks.slice(0, targetCars);
  console.log(`\n\n🎯 Now scraping details for ${carsToScrape.length} cars...\n`);

  let scrapedCars = [];

  // Scrape each detail page
  for (let i = 0; i < carsToScrape.length; i++) {
    const car = carsToScrape[i];
    console.log(`[${i + 1}/${carsToScrape.length}] 🔗 Scraping: ${car.title}`);

    try {
      await page.goto(car.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get description and listing images
      const details = await page.evaluate(() => {
        // Get description
        const descContainer = document.querySelector('.car-details__description-text');
        const description = descContainer ? descContainer.innerText.trim() : "";

        // Get all listing images from the gallery swiper
        const imageGallery = [];

        // Look for images in the swiper gallery
        const swiperContainer = document.querySelector('.gallery .swiper-wrapper');
        if (swiperContainer) {
          const imageElements = swiperContainer.querySelectorAll('img[src*="core-processed.static.qic.online"]');
          imageElements.forEach(img => {
            const src = img.src || img.getAttribute('src') || img.dataset.src;
            if (src && src.includes('core-processed.static.qic.online')) {
              imageGallery.push(src);
            }
          });
        }

        return {
          description,
          listingImages: imageGallery
        };
      });

      let whatsappPhone = "";

      // Try to click phone button and extract from popup
      try {
        const phoneButton = await page.$('button[data-test="seller-number"]');
        if (phoneButton) {
          await phoneButton.click();
          console.log(`      📞 Clicked "Show number" button...`);

          await new Promise(resolve => setTimeout(resolve, 2000));

          // Extract phone from popup
          const phoneData = await page.evaluate(() => {
            // Look for phone in popup content
            const popupContent = document.querySelector('.popup__content');
            if (popupContent) {
              const phoneEl = popupContent.querySelector('p');
              if (phoneEl) {
                return phoneEl.innerText.trim();
              }
            }
            return "";
          });

          if (phoneData) {
            whatsappPhone = phoneData.replace(/\s/g, '');
            if (!whatsappPhone.startsWith('+')) whatsappPhone = '+' + whatsappPhone;
          }

          console.log(`      📱 Found phone: ${phoneData}`);
        } else {
          console.log(`      ⚠️ Phone button not found`);
        }
      } catch (err) {
        console.log(`      ⚠️ Error clicking phone button: ${err.message}`);
      }

      const fullCar = {
        ...car,
        description: details.description,
        phone: whatsappPhone || "Not available",
        listingImages: details.listingImages || []
      };

      scrapedCars.push(fullCar);

      if (fullCar.phone !== "Not available") {
        console.log(`   ✓ Phone: ${fullCar.phone}`);
      } else {
        console.log(`   ⚠️ Phone: Not found`);
      }
      console.log(`   ✓ Found ${fullCar.listingImages.length} listing images`);

      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      scrapedCars.push({
        ...car,
        description: "Failed to scrape",
        phone: "Failed to scrape",
        listingImages: []
      });
    }
  }

  console.log(`\n\n✅ Successfully scraped ${scrapedCars.length} cars with full details`);

  // Upload to Google Sheets
  console.log("\n📊 Uploading to Google Sheets...");
  try {
    await uploadToGoogleSheets(scrapedCars);
    console.log("✅ Successfully updated Google Sheets!");
  } catch (err) {
    console.error("❌ Failed to upload to Google Sheets:", err.message);
  }

  // Send Discord notification
  try {
    await sendDiscordNotification(scrapedCars.length);
  } catch (err) {
    console.error('❌ Discord notification failed:', err.message);
  }

  await browser.close();
}

async function uploadToGoogleSheets(cars) {
  const { google } = require('googleapis');

  // Load from config
  const { spreadsheetId } = require('./sheet-config.json');

  // Hardcoded credentials (same as other scrapers)
  const credentials = {
    type: "service_account",
    project_id: "fleet-petal-469606-p4",
    private_key_id: "b867cb0bda0a65b7c649bb56aefc98399164fa08",
    private_key: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDnwxKXKPKRE2FF
oqddnoutu7jT+ye1q5qjkEKLrw67NNv/zBb28vTEoj5GIPEYSG6Mg11mMySp7AGB
rguecB6rTa0vDM/7nn0lAU+WiqZjdtULMgK07TvPcnxr2ikvKQdHDfZ5Rl4gQNOF
EgPmGC0X21WF7HZBYfPKU9gmDZp4G5oHmb8P9RxW1T8PBdKgCWxGg0/hExd0XAj8
OZPnPltMgL32nlEhNWWvfi1rqWfxdN27jfDYHneF7HXTwTFJi9XI22N7GaOWZIHC
X9zMA9e543MmkY0M0d4AtmX6PueNOJXcVN+B/PIYhNcqjsljQFO9kjagCLUbQ0gU
vv+tF5wXAgMBAAECggEADIrZwGhDZFPuEWfH8sDIFcSRScuPe30h3WGXvSZ7cujD
65Grpn0OGQjsuzym8r9f8c1dw+oKcGjoySm80Dvu6CqU4w7bv8xbQNVToM9R40a3
9do+Tw6A2ToWMkhre479XIkmNXiRuUe414lBJvXxyGPWB4bjlkGktDNNNC+YesQG
2JMOIy3dNJDJACC20KYYdOUsPYqxqwZv3O9EwajMksB6mXF5m1wj/JIhgyAvLNDE
qBQYCXKFUeOLR3OFfPMCanTkHCVWD22hRx0eL2X+H+862rPe86S3u0hog0nwNrdg
48lTXO9f8dvr/r8+VUrTZ/EspgHw9BL8EqvtnEMneQKBgQD+nD852GEb7MjxrwHL
DnLLTBv8KWG9U/gOUJERoMORC37TEe4pSQgTMe/QvaJyRYVjN4bjbhwjPlpULBAF
8dde55lTcl8zN2yQjPXnldLs10C977+1a1GeKT6L8w0CM6QBhTMl0Os8ZknNtR9l
YyLc4dX0yDshgOnnJpTzAPSBuQKBgQDpBuaiiLceQimF58NgA2S7BXHroh2irEvV
/ab1KW407pTmlv0JtPUExg82HCx8YXjAiLGl7yerkN1hlcM3+A1viNKprF0cLQN7
u6ASNILKE99nlvRA8oSLvvIhuXfQ9mCHudJwhMblmXfYMOl9yaa1AA7CZX4ft5nR
PO0/Hpo0TwKBgFta/sinnfhiFpu5WqBcN85AKc5pnrtLFLc2K0cy8tjpUgEz7st7
e90/TrgMQuxTi4/VDZ4vFQOETO7kvH8VjlxsJzSs1gHPgjG/kkAdHwiCF6XPD29t
6WQhkmKuu90tYEx3WanY837BiPu5YGGFl62/joB9E9JqqgKZclpa3mBpAoGAU4eJ
vNFM8qe8wqclPZF51iBJibF+9gTU2kwmQNMtEgRDk7Sj14rqGV/1q+vFdoBqDHnz
VAu6KKGw+X35kGJ2Tni5KuECL0tjaEMFSgFQsKcW+cb+nxlPsdgsazJUZK8sQvq1
GGg/86VjdDd0OwbBnzf6EmzXHP9vP7WbRXjuxbkCgYEAo6lwhYROVprIdTBEfGT/
m6JLoNCVh5GAcJyd2mWYBaxu1nbHWmkfqcG7A8+VVN2GBObzaFQ9RAUSk8yyHPuZ
dmC35VdDBF1nOrrCnte46jkNLEHuL6WEh6VwJBhG4Vg1yQmHNug/ydA43uuf82Wq
iVDaive9Ljs8CET3FpKHnHI=
-----END PRIVATE KEY-----
`,
    client_email: "carslaepushtosheet@fleet-petal-469606-p4.iam.gserviceaccount.com",
    client_id: "114547508604922002943",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/carslaepushtosheet%40fleet-petal-469606-p4.iam.gserviceaccount.com",
    universe_domain: "googleapis.com"
  };

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Prepare headers
  const headers = [
    'Title', 'Price', 'Year', 'Mileage', 'Phone', 'Description', 'Listing Images', 'URL'
  ];

  // Prepare rows
  const rows = cars.map(car => [
    car.title || '',
    car.price || '',
    car.year || '',
    car.mileage || '',
    car.phone || '',
    car.description || '',
    car.listingImages ? car.listingImages.join(' | ') : '',
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
  const message = `${count} pushed successfully for qic-market`;

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

scrapeQicMarket().catch(console.error);
