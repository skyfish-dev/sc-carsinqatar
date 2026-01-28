const puppeteer = require('puppeteer');
const readline = require('readline');
const {google} = require('googleapis');
const fs = require('fs');
const https = require('https');

async function scrapeQatarLiving(numCars) {
  const browser = await puppeteer.launch({
    headless: true, // Run headless for faster scraping
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

    console.log('🚗 Starting to scrape Qatar Living cars...');

    const baseUrl = 'https://qlv.qatarliving.com/en/vehicles/cars';
    const collected = [];
    let currentPage = 1;
    let emptyPageCount = 0;

    while (collected.length < numCars) {
      try {
        const cars = await retryWithExponentialBackoff(async () => await scrapeCarsFromPage(page, currentPage, baseUrl));

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
        console.error(`❌ Error on page ${currentPage} after retries:`, error.message);
        break; // Stop if page fails after retries
      }
    }

    console.log(`\n✅ Successfully extracted ${collected.length} car listings!`);

    // Limit to the requested number
    console.log(`\n📏 Processing all ${collected.length} collected cars...`);
    const limitedCars = collected;

    if (limitedCars.length === 0) {
      console.log('\n⚠️  No listings found. Saving debug screenshot...');
      await page.screenshot({ path: 'debug-no-results-qatarliving.png', fullPage: true });
      console.log('Screenshot saved as debug-no-results-qatarliving.png');
    }

    console.log(`\n✅ Scraping completed with ${limitedCars.length} cars!`);

    // Scrape details from each car listing page
    console.log(`\n🔗 Visiting each listing page for detailed data...`);
    for (let i = 0; i < limitedCars.length; i++) {
      const car = limitedCars[i];
      console.log(`\n   Visiting car ${i+1}: ${car.title}`);

      try {
        const details = await retryWithExponentialBackoff(async () => await scrapeCarDetails(browser, car));

        car.description = details.description;
        car.images = details.images;
        car.phone = details.phone;

        // Always set the thumbnail to the first detail image for Qatar Living
        if (details.images.length > 0) {
          car.image = details.images[0];
          console.log(`   ✓ Set thumbnail to first image: ${details.images[0].replace(/.*\//, '')}`);
        }

        if (car.description === 'N/A') {
          car.description = car.title;
        }

        console.log(`   ✓ Found ${details.images.length} images, description (${details.description.length} chars), phone: ${details.phone}`);

        // 1 second cooldown between requests
        if (i < limitedCars.length - 1) {
          await wait(1000);
        }
      } catch (err) {
        console.error(`   ❌ Error scraping car ${i+1} after retries:`, err.message);
        car.description = 'N/A';
        car.images = [];
        car.phone = 'N/A';

        // Even in case of error, use title as description
        car.description = car.title;
      }
    }

    console.log(`\n✅ Detail scraping completed!`);

    return limitedCars;
  } catch (error) {
    console.error('\n❌ Error during scraping:', error.message);

    try {
      await page.screenshot({ path: 'error-screenshot-qatarliving.png' });
      console.log('Error screenshot saved as error-screenshot-qatarliving.png');
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

async function scrapeCarsFromPage(page, currentPage, baseUrl) {
  const pageUrl = currentPage === 1 ? baseUrl : `${baseUrl}?page=${currentPage}`;

  console.log(`📄 Navigating to page ${currentPage}: ${pageUrl}`);
  await page.goto(pageUrl, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  console.log('✓ Page loaded');

  // Wait for content to load
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Scroll to load all items
  await autoScroll(page);

  console.log('📊 Extracting car listings...');

  // Extract car listings
  const cars = await page.evaluate(() => {
    const listings = [];

    // Find all listing links
    const links = document.querySelectorAll('a[href*="/en/vehicles/cars/"]');
    console.log(`Found ${links.length} links`);

    links.forEach((link, index) => {
      try {
        const url = link.href;

        // Title from h2 inside the link
        const titleEl = link.querySelector('h2');
        const title = titleEl ? titleEl.innerText.trim() : 'N/A';

        // Get all detail elements
        const details = link.querySelectorAll('p[class*="css-rtbbds"]');
        const mileage = details.length > 0 ? details[0].innerText.trim() : 'N/A';
        const fuel = details.length > 1 ? details[1].innerText.trim() : 'N/A';
        const capacity = details.length > 2 ? details[2].innerText.trim() : 'N/A';
        const cylinders = details.length > 3 ? details[3].innerText.trim() : 'N/A';

        // Price from h3 containing QAR
        const priceEl = link.querySelector('h3');
        let price = priceEl ? priceEl.innerText.replace(/\D/g, '') : 'N/A';

        // Thumbnail - try to find img alt="Ad Image" (the first/largest one)
        const imgEl = document.querySelector('img[alt="Ad Image"]:first-child') || document.querySelector('img[alt="Ad Image"]');
        let image = imgEl ? imgEl.src : 'N/A';

        // As fallback, try to get from the images array that we'll extract later
        if (image === 'N/A' || image.includes('chevrolet') || image.includes('Chevrolet')) {
          // We can't get images here yet, but we'll fix this later in the detail scraping
          console.log(`   ⚠️  Defaulting image as "${image}" for ${title} - will attempt to fix from detail images`);
        }

        if (title !== 'N/A' && url !== 'N/A' && price !== 'N/A') {
          listings.push({ title, url, price, mileage, image, fuel, capacity, cylinders });
        }
      } catch (err) {
        console.error(`Error extracting listing ${index}:`, err.message);
      }
    });

    return listings;
  });

  console.log(`✅ Extracted ${cars.length} cars from page ${currentPage}`);

  return cars;
}

async function scrapeCarDetails(browser, car) {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const detailPage = await browser.newPage();
  try {
    await detailPage.setUserAgent(userAgent);
    await detailPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    await gotoWithRetry(detailPage, car.url);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Click phone button to reveal phone
    try {
      const callButton = await detailPage.$('button[class*="MuiButton-outlined"][class*="MuiButton-outlinedPrimary"]');
      if (callButton) {
        await callButton.click();
        await detailPage.waitForTimeout(3000); // increased wait
      }
    } catch (e) {
      console.log(`     Phone button not found or clickable`);
    }

    const details = await detailPage.evaluate(() => {
      // Extract description
      const descEl = document.querySelector('div[class*="MuiTypography-root"][class*="MuiTypography-body1"][class*="css-qvi4u1"]');
      let description = 'N/A';
      if (descEl) {
        description = descEl.innerText.trim() || descEl.textContent.trim();
      }

      // Extract images
      const imgElements = document.querySelectorAll('ul.thumbs li.thumb img[src*="ad-images-output/prod/"]');
      const images = Array.from(imgElements).map(img => img.src).filter((src, index, arr) => arr.indexOf(src) === index); // unique

      // Extract phone number after click
      const phoneSelectors = ['a[href^="tel:"]', 'div[class*="MuiTypography-root"][class*="MuiTypography-h3Medium"]', '[class*="phone"]', 'a[href*="whatsapp.com/send?phone"]'];
      let phone = 'N/A';
      for (let sel of phoneSelectors) {
        const phoneEls = document.querySelectorAll(sel);
        for (const el of phoneEls) {
          let content = el.textContent.trim() || el.innerText.trim();
          let phoneMatch = content.match(/(\+\d{1,4}[\s\-\(]?\d+[\s\-\)]?[\d\s\-\(\)]{7,})/g);
          if (!phoneMatch && el.tagName === 'A' && el.href && el.href.startsWith('tel:')) {
            content = el.href.replace('tel:', '');
            phoneMatch = content.match(/(\+\d{1,4}[\s\-\(]?\d+[\s\-\)]?[\d\s\-\(\)]{7,})/g);
          }
          if (phoneMatch) {
            phone = phoneMatch[0];
            break;
          }
        }
        if (phone !== 'N/A') break;
      }

      // Fallback: search for phone-like pattern in page text
      if (phone === 'N/A') {
        const bodyText = document.body.innerText;
        const phoneMatch = bodyText.match(/(\+\d{1,4}[\s\-\(]?\d+[\s\-\)]?[\d\s\-\(\)]{7,})/g);
        if (phoneMatch && phoneMatch.length) {
          phone = phoneMatch[0];
        }
      }

      return { description, images, phone };
    });

    return details;
  } finally {
    await detailPage.close();
  }
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

// General retry function with exponential backoff
async function retryWithExponentialBackoff(fn, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt < maxAttempts) {
        const delay = 1000 * Math.pow(2, attempt - 1); // First retry: 1s, second: 2s, third: 4s, etc.
        console.log(`   ⚠️  Operation failed, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
        await wait(delay);
      } else {
        console.log(`   ❌ Operation failed after ${maxAttempts} attempts`);
        throw error;
      }
    }
  }
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
  const spreadsheetId = '17abFM5O_ITXhuc8e87V7P7_pfYZHWTQ0nxfwudQo-6A';

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
  const message = `Added ${numItems} cars to sheets thru Qatar Living`;

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
  console.log('🚀 Starting Qatar Living Car Scraper...\n');

  const numCarsArg = process.argv[2];
  let numCars;
  if (numCarsArg) {
    numCars = parseInt(numCarsArg) || 1;
  } else {
    const numCarsInput = await askQuestion('How many cars do you want to scrape? ');
    numCars = parseInt(numCarsInput) || 1; // default to 1
  }
  console.log(`Scraping ${numCars} cars...\n`);

  try {
    const cars = await scrapeQatarLiving(numCars);

    // Save to Google Sheets
    await saveToSheets(cars);
    console.log(`\n📊 Data uploaded to Google Sheets`);

    // Send Discord webhook
    try {
      await sendDiscordWebhook(numCars);
    } catch (webhookError) {
      console.error('\n⚠️  Failed to send Discord webhook, but scraping completed:', webhookError.message);
    }

    console.log(`\n\n✅ Scraping completed successfully!`);
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Scraping failed:', error.message);
    process.exit(1);
  }
}

run();
