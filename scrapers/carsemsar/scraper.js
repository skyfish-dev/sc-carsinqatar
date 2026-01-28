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

async function scrapeCarsEmsar() {
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
      "--disable-renderer-backgrounding",
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
  let scrapedCars = [];

  // Keep scraping pages until we have enough car URLs
  while (allCarLinks.length < targetCars) {
    const url = `https://www.carsemsar.com/en/qatar/search?page=${currentPage}`;
    console.log(`\n📄 Scraping page ${currentPage}: ${url}`);

    try {
      await retryWithBackoff(
        () => page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 120000,
        }),
        3,
        "page navigation"
      );

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if products exist on this page
      const possibleSelectors = [
        '.listings-listing',
        '[class*="listing"]',
        'h3.listing-title',
        '[class*="card"]'
      ];

      let foundSelector = null;
      for (const selector of possibleSelectors) {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          foundSelector = selector;
          break;
        }
      }

      if (!foundSelector) {
        console.log(`❌ No more listings found on page ${currentPage}`);
        break;
      }

      await page.waitForSelector('h3.listing-title', {
        visible: true,
        timeout: 10000,
      });

      // Scroll to load lazy content
      await autoScroll(page);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Extract car links from this page
      const pageCarLinks = await page.evaluate(() => {
        const items = [];

        const listings = document.querySelectorAll('.listing-item, [class*="listing"]');
        if (listings.length === 0) {
          // Fallback to look for title links
          const titles = document.querySelectorAll('h3.listing-title a[href]');
          titles.forEach((titleLink) => {
            const a = titleLink.closest('a') || titleLink;
            const wrapper = a.closest('.card, .listing-item, article') || a.parentElement.parentElement;

            const title = titleLink.innerText.trim() || "";
            const priceEl = wrapper.querySelector('li.listing-price .field-value');
            const price = priceEl ? `QAR ${priceEl.innerText.trim()}` : '';
            const url = a.href;

            if (url && title) {
              items.push({
                title,
                price,
                priceValue: priceEl ? priceEl.innerText.trim() : '',
                priceCurrency: 'QAR',
                url,
                specs: {}
              });
            }
          });
        } else {
          listings.forEach((wrapper) => {
            try {
              const titleLink = wrapper.querySelector('h3.listing-title a');
              if (!titleLink) return;

              const title = titleLink.innerText.trim();
              const priceEl = wrapper.querySelector('li.listing-price .field-value');
              const price = priceEl ? `QAR ${priceEl.innerText.trim()}` : '';
              const url = titleLink.href;

              const specs = {};
              const specLists = wrapper.querySelectorAll('li');
              specLists.forEach((li) => {
                const label = li.querySelector('.field-label');
                const value = li.querySelector('.field-value');
                if (label && value) {
                  specs[label.innerText.trim()] = value.innerText.trim();
                }
              });

              if (url) {
                items.push({
                  title,
                  price,
                  priceValue: priceEl ? priceEl.innerText.trim() : '',
                  priceCurrency: 'QAR',
                  url,
                  specs
                });
              }
            } catch (err) {
              console.error('Error extracting listing:', err.message);
            }
          });
        }

        return items;
      });

      // Deduplicate pageCarLinks based on URL
      const uniquePageCarLinks = [];
      const seen = new Set();
      for (const car of pageCarLinks) {
        if (!seen.has(car.url)) {
          seen.add(car.url);
          uniquePageCarLinks.push(car);
        }
      }

      console.log(`   ✓ Found ${uniquePageCarLinks.length} cars on page ${currentPage}`);

      if (uniquePageCarLinks.length === 0) {
        console.log(`❌ No cars found on page ${currentPage}, stopping pagination`);
        break;
      }

      const remaining = Math.max(0, targetCars - allCarLinks.length);
      allCarLinks.push(...uniquePageCarLinks.slice(0, remaining));
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

  // Process all collected cars
  const carsToScrape = allCarLinks;
  console.log(`\n\n🎯 Now scraping details for ${carsToScrape.length} cars...\n`);

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
        // Get all listing images from the gallery
        const imageGallery = [];
        const seen = new Set();

        // Look for images in .f-thumbs__track
        const thumbsTrack = document.querySelector('.f-thumbs__track');
        if (thumbsTrack) {
          const thumbImages = thumbsTrack.querySelectorAll('img.f-thumbs__slide__img');
          thumbImages.forEach(img => {
            const src = img.src || img.dataset.src;
            if (src) {
              if (!seen.has(src)) {
                seen.add(src);
                imageGallery.push(src);
              }
            }
          });
        }

        // If not found, try other selectors
        if (imageGallery.length === 0) {
          const allImages = document.querySelectorAll('div[class*="gallery"] img, .swiper img');
          allImages.forEach(img => {
            const src = img.src || img.dataset.src;
            if (src && src.includes('s3.amazonaws.com') && src.includes('/cars/')) {
              if (!seen.has(src)) {
                seen.add(src);
                imageGallery.push(src);
              }
            }
          });
        }

        // Extract specs from detail page
        const specs = {};
        const specItems = document.querySelectorAll('li');
        specItems.forEach((li) => {
          const label = li.querySelector('.field-label');
          const value = li.querySelector('.field-value');
          if (label && value) {
            const labelText = label.innerText.trim();
            const valueText = value.innerText.trim();
            if (labelText && valueText) {
              specs[labelText] = valueText;
            }
          }
        });

        return {
          description: document.querySelector('p.description, .description')?.innerText?.trim() || "",
          listingImages: imageGallery,
          specs
        };
      });

      let whatsappPhone = "";

      // Try to find phone - look for call buttons or contact info
      try {
        // Look for buttons with 'call', 'contact' etc.
        const possibleButtons = ['button:contains("Call")', 'a[href*="tel:"]', '.contact-button', '[class*="call"]'];
        let clicked = false;

        for (const btnSelector of possibleButtons) {
          try {
            await page.waitForSelector(btnSelector, { timeout: 3000 });
            await page.click(btnSelector);
            clicked = true;
            break;
          } catch (e) {
            // Try next
          }
        }

        if (clicked) {
          await new Promise(resolve => setTimeout(resolve, 2000));

          const phoneData = await page.evaluate(() => {
            // Look for tel: links
            const telLinks = document.querySelectorAll('a[href^="tel:"]');
            if (telLinks.length > 0) {
              return telLinks[0].href.replace('tel:', '');
            }

            // Look for phone numbers in text
            const bodyText = document.body.innerText;
            const phoneMatch = bodyText.match(/(\+?\d{1,4}[\s\-\(\)]*\d{3,4}[\s\-\(\)]*\d{3,4}[\s\-\(\)]*\d{3,4})/);
            if (phoneMatch) return phoneMatch[1];

            return "";
          });

          if (phoneData) {
            whatsappPhone = phoneData.replace(/\s/g, '').replace(/^0+/, '');
            if (!whatsappPhone.startsWith('+')) whatsappPhone = '+974' + whatsappPhone; // Qatar prefix
          }
        }
      } catch (err) {
        console.log(`      ⚠️ Call button not found: ${err.message}`);
      }

      const fullCar = {
        ...car,
        description: details.description,
        phone: whatsappPhone || "Not available",
        listingImages: details.listingImages || [],
        specs: { ...car.specs, ...details.specs } // Merge specs
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
        listingImages: [],
        specs: car.specs || {}
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

  // Prepare headers - adapted for carsemsar
  const headers = [
    'Title', 'Price', 'Mileage', 'Body Style', 'Phone', 'Listing Images', 'URL'
  ];

  // Prepare rows
  const rows = cars.map(car => [
    car.title || '',
    (car.priceValue || '').replace('QAR ', ''),
    car.specs?.Mileage || car.specs?.['Mileage'] || '',
    car.specs?.['Body Style'] || car.specs?.['Body Style'] || '',
    car.phone || '',
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
  const message = `${count} pushed successfully for carsemsar`;

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

scrapeCarsEmsar().catch(console.error);
