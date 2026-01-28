const puppeteer = require('puppeteer');
const readline = require('readline');
const {google} = require('googleapis');
const fs = require('fs');
const https = require('https');

async function scrapeMzadQatar(numCars) {
  const browser = await puppeteer.launch({
    headless: true, // Change to false to see the browser
    protocolTimeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    console.log('🚗 Starting to scrape Mzad Qatar cars...');

    const baseUrl = 'https://mzadqatar.com/en/cars/sale?categoryId=1&subCategoryId=0&typeId=0';
    const collected = [];
    let currentPage = 1;
    let emptyPageCount = 0;

    while (collected.length < numCars) {
      const pageUrl = currentPage === 1 ? baseUrl : `${baseUrl}&page=${currentPage}`;

      console.log(`\n📄 Navigating to page ${currentPage}: ${pageUrl}`);
      try {
        await page.goto(pageUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        console.log('✓ Page loaded');

        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Scroll to load all items
        await autoScroll(page);

        console.log('📊 Extracting car listings...');

        // Extract car listings using the actual HTML structure
        const cars = await page.evaluate(() => {
          const listings = [];

          // Target the specific containers from the HTML structure
          // Regular products: .product_section

          const regularProducts = document.querySelectorAll('.product_section');

          console.log(`Found ${regularProducts.length} regular products`);

          // Process regular products
          regularProducts.forEach((item, index) => {
            try {
              // Extract URL
              const linkEl = item.querySelector('a.custom_product_name');
              const url = linkEl ? linkEl.href : 'N/A';

              // Extract title from h4
              const titleEl = item.querySelector('h4');
              const title = titleEl ? titleEl.innerText.trim() : 'N/A';

              // Extract price from .custom_color_currency
              const priceEl = item.querySelector('.custom_color_currency');
              let price = priceEl ? priceEl.innerText.trim() : 'N/A';
              if (price !== 'N/A') {
                price = price.replace(/\D/g, '');
              }

              // Extract image
              const imgEl = item.querySelector('img[src*="content.mzadqatar.com"]');
              const image = imgEl ? imgEl.src : 'N/A';

              // Extract year and mileage
              const detailLabels = item.querySelectorAll('.display-show-horizontal.custom_box_horizontal label');
              const year = detailLabels.length >= 1 ? detailLabels[0].innerText.trim() : 'N/A';
              const mileage = detailLabels.length >= 2 ? detailLabels[1].innerText.trim() : 'N/A';

              if (title !== 'N/A' && url !== 'N/A' && price !== 'N/A') {
                listings.push({ title, url, price, year, mileage, image });
              }
            } catch (err) {
              console.error(`Error extracting regular product ${index}:`, err.message);
            }
          });

          return listings;
        });

        console.log(`✅ Extracted ${cars.length} cars from page ${currentPage}`);

        collected.push(...cars);

        if (cars.length > 0) {
          emptyPageCount = 0;
        } else {
          emptyPageCount++;
          console.log(`⚠️  No cars found on page ${currentPage}, empty page count: ${emptyPageCount}`);
        }

        if (collected.length < numCars && emptyPageCount < 5) {
          currentPage++;
          console.log(`🔄 Need more cars, going to next page...`);
        } else {
          break;
        }
      } catch (error) {
        console.error(`❌ Error on page ${currentPage}:`, error.message);
        break; // Stop if page fails
      }
    }

    console.log(`\n✅ Successfully extracted ${collected.length} car listings!`);

    // Limit to the requested number
    console.log(`\n📏 Processing all ${collected.length} collected cars...`);
    const limitedCars = collected;

    if (limitedCars.length === 0) {
      console.log('\n⚠️  No listings found. Taking screenshot for debugging...');
      await page.screenshot({ path: 'debug-no-results.png', fullPage: true });
      console.log('Screenshot saved as debug-no-results.png');
    }

    // Scrape details from each car listing page
    console.log(`\n🔗 Visiting each listing page for detailed data...`);
    for (let i = 0; i < limitedCars.length; i++) {
      const car = limitedCars[i];
      console.log(`\n   Visiting car ${i+1}: ${car.title}`);

      try {
        const detailPage = await browser.newPage();
        await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await detailPage.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
          });
        });

        await gotoWithRetry(detailPage, car.url);
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Click phone number button to reveal phone
        try {
          await detailPage.click('.phone_number');
          await detailPage.waitForTimeout(2000);
        } catch (e) {
          console.log(`     Phone button not found or clickable`);
        }

        const details = await detailPage.evaluate(() => {
          // Extract description
          const descEl = document.querySelector('p.pr_description');
          const description = descEl ? descEl.innerText.trim() : 'N/A';

          // Extract images
          const imgElements = document.querySelectorAll('.img-select img[src*="content.mzadqatar.com"], .product_image img[src*="content.mzadqatar.com"]');
          const images = Array.from(imgElements).map(img => img.src).filter((src, index, arr) => arr.indexOf(src) === index); // unique

          // Extract phone number (after clicking the button)
          const phoneSelectors = ['.phone_number_display', '.phoneNumber', '.mobile_number', '.contact_phone', '.showed-phone', '.phone-display', '[class*="phone"]'];
          let phone = 'N/A';
          for (let sel of phoneSelectors) {
            const phoneEl = document.querySelector(sel);
            if (phoneEl && phoneEl.textContent.trim()) {
              phone = phoneEl.textContent.trim();
              break;
            }
          }

          // Fallback: search for phone-like pattern in page text
          if (phone === 'N/A') {
            const bodyText = document.body.innerText;
            const phoneMatch = bodyText.match(/(\+\d{1,4}[\s\-\(]?\d+[\s\-\)]?[\d\s\-\(\)]{7,})/g);
            if (phoneMatch && phoneMatch.length) {
              phone = phoneMatch[0];
            }
          }

          // Extract geartype
          let geartype = 'N/A';
          const infoParas = document.querySelectorAll('p.pr_info_name');
          for (let p of infoParas) {
            const text = p.textContent.trim();
            if (text === 'Automatic' || text === 'Manual') {
              geartype = text;
              break;
            }
          }

          // Extract year from detail page (if available)
          let yearDetail = 'N/A';
          for (let p of infoParas) {
            const text = p.textContent.trim();
            if (/^\d{4}$/.test(text) && parseInt(text) > 1900 && parseInt(text) < 2030) {
              yearDetail = text;
              break;
            }
          }

          return { description, images, phone, geartype, yearDetail };
        });

        car.description = details.description;
        car.images = details.images;
        car.phone = details.phone;
        car.geartype = details.geartype;
        if (details.yearDetail !== 'N/A') car.year = details.yearDetail;

        console.log(`   ✓ Found ${details.images.length} images, description (${details.description.length} chars), phone: ${details.phone}, geartype: ${details.geartype}, year: ${details.yearDetail}`);

        await detailPage.close();

        // 1 second cooldown between requests
        if (i < limitedCars.length - 1) {
          await wait(1000);
        }
      } catch (err) {
        console.error(`   ❌ Error scraping car ${i+1}:`, err.message);
        car.description = 'N/A';
        car.images = [];
        car.phone = 'N/A';
        car.geartype = 'N/A';
      }
    }

    console.log(`\n✅ Detail scraping completed!`);

    // Save to Google Sheets
    const dataToSave = limitedCars.map(car => ({
      "car name": car.title,
      "listing link": car.url,
      "price": car.price,
      "year": car.year,
      "mileage": car.mileage,
      "thumbnail": car.image,
      "description": car.description,
      "images": car.images,
      "phone": car.phone,
      "geartype": car.geartype
    }));

    await saveToSheets(dataToSave);
    console.log(`\n💾 Data saved to Google Sheets`);

    // Send Discord webhook
    try {
      await sendDiscordWebhook(limitedCars.length);
    } catch (webhookError) {
      console.error('\n⚠️  Failed to send Discord webhook, but scraping completed:', webhookError.message);
    }

    return limitedCars;
  } catch (error) {
    console.error('\n❌ Error during scraping:', error.message);

    try {
      await page.screenshot({ path: 'error-screenshot.png' });
      console.log('Error screenshot saved as error-screenshot.png');
    } catch (screenshotError) {
      console.log('Could not take error screenshot');
    }

    throw error;
  } finally {
    await browser.close();
  }
}

// Helper function to scroll the page
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
      }, 150);
    });
  });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
}



// Function to ask question
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoWithRetry(page, url, maxRetries = 5) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return; // success
    } catch (error) {
      attempts++;
      if (attempts >= maxRetries) {
        throw error;
      }
      const retryDelay = 1000 * Math.pow(2, attempts - 1); // 1, 2, 4, 8, 16
      console.log(`   ⚠️  Goto failed, retrying in ${retryDelay}ms (attempt ${attempts})`);
      await wait(retryDelay);
    }
  }
}

async function saveToSheets(data) {
  const spreadsheetId = '1IheLoMbpxw1vDNYaZexS7zrL0e01-4KXeLokqU3FYBg';

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
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({version: 'v4', auth});

  if (data.length === 0) {
    console.log('No data to save');
    return;
  }

    // Clear the sheet
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'A1:Z10000'
    });

  // Prepare headers and rows
  const headers = Object.keys(data[0]);
  const rows = data.map(obj => headers.map(key => key === 'images' ? JSON.stringify(obj[key]) : obj[key]));
  const values = [headers, ...rows];

  // Update the sheet starting from A1
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'A1',
    valueInputOption: 'RAW',
    resource: { values }
  });
}

async function sendDiscordWebhook(numItems) {
  const webhookUrl = 'https://discord.com/api/webhooks/1432047999155961938/RaccihIk6Nzq7cDNO2OZG4w6ZJCDlKEaZiNqbn_aU5h7WDcgs0tryJ9xvhWQdiYJyOHk';
  const message = `Added ${numItems} items to sheets thru Mzad Qatar`;

  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`\n📢 Discord webhook sent successfully: "${message}"`);
        resolve();
      } else {
        console.error(`\n❌ Discord webhook failed: ${res.statusCode} ${res.statusMessage}`);
        reject(new Error(`Webhook failed: ${res.statusCode}`));
      }
    });

    req.on('error', (error) => {
      console.error('\n❌ Discord webhook error:', error.message);
      reject(error);
    });

    req.write(JSON.stringify({ content: message }));
    req.end();
  });
}

// Run the scraper
async function run() {
  console.log('🚀 Starting Mzad Qatar Car Scraper...\n');

  const numCarsArg = process.argv[2];
  let numCars;
  if (numCarsArg) {
    numCars = parseInt(numCarsArg) || 10;
  } else {
    const numCarsInput = await askQuestion('How many cars do you want to scrape? ');
    numCars = parseInt(numCarsInput) || 10; // default to 10 if invalid
  }
  console.log(`Scraping ${numCars} cars...\n`);

  try {
    await scrapeMzadQatar(numCars);
    console.log(`\n\n✅ Scraping completed successfully!`);
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Scraping failed');
    process.exit(1);
  }
}

run();
