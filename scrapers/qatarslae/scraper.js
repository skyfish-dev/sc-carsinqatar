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

  return new Promise(resolve => rl.question(query, answer => {
    rl.close();
    resolve(answer);
  }));
}

async function scrapeQatarSale() {
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
  let scrapedCars = [];

  // Keep scraping pages until we have enough car URLs
  while (allCarLinks.length < targetCars) {
    const url = `https://qatarsale.com/en/products/cars_for_sale?page=${currentPage}`;
    console.log(`\n📄 Scraping page ${currentPage}: ${url}`);
    
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if products exist on this page
      const possibleSelectors = [
        '.classic-card-wrapper',
        '.product-card',
        '.car-listing',
        '[class*="product"]',
        '[class*="card"]',
        '[class*="listing"]'
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

      await page.waitForSelector(foundSelector, {
        visible: true,
        timeout: 10000,
      });

      // Scroll to load lazy content
      await autoScroll(page);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Extract car links from this page
      const pageCarLinks = await page.evaluate(() => {
        const items = [];
        let wrappers = document.querySelectorAll(".classic-card-wrapper");
        
        if (wrappers.length === 0) {
          wrappers = document.querySelectorAll('[class*="product-card"], [class*="listing-item"], [class*="car-item"]');
        }
        
        wrappers.forEach((wrapper) => {
          try {
            const brand = wrapper.querySelector(".title-section .p3, .title .p3, h3")?.innerText?.trim() || "";
            const model = wrapper.querySelector(".title-section .p5, .title .p5, h4")?.innerText?.trim() || "";
            const variant = wrapper.querySelector(".title-section .p5.sub-header, .subtitle")?.innerText?.trim() || "";
            
            const priceValue = wrapper.querySelector(".product-price-info .p1, .price .value, .p1")?.innerText?.trim() || "";
            const priceCurrency = wrapper.querySelector(".product-price-info .p5, .price .currency")?.innerText?.trim() || "Q.R";
            
            const img = wrapper.querySelector("img");
            const image = img?.src || img?.getAttribute("data-src") || "";
            
            const link = wrapper.querySelector("a[href*='product'], a[href*='car']");
            const url = link?.href || "";
            
            const condition = wrapper.querySelector(".ribbon-text .p4, .badge, .condition")?.innerText?.trim() || "";
            const sellerType = wrapper.querySelector(".showroom-name, .seller-type")?.innerText?.trim() || "";
            
            const viewsEl = wrapper.querySelector(".menu-bar-controls .p4, .views");
            const views = parseInt(viewsEl?.innerText?.trim() || "0") || 0;
            
            const specs = {};
            const specLines = wrapper.querySelectorAll(".def-line, .spec-item, [class*='specification']");
            specLines.forEach((def) => {
              const key = def.querySelector(".def-name, .spec-name, dt")?.innerText?.trim();
              const val = def.querySelector(".def-value, .spec-value, dd")?.innerText?.trim();
              if (key && val) {
                specs[key] = val;
              }
            });
            
            if (url) {
              items.push({
                brand,
                model,
                variant,
                title: `${brand} ${model} ${variant}`.trim(),
                price: `${priceValue} ${priceCurrency}`.trim(),
                priceValue,
                priceCurrency,
                condition,
                sellerType,
                views,
                image,
                url,
                specs
              });
            }
          } catch (err) {
            console.error('Error extracting listing:', err.message);
          }
        });
        
        return items;
      });

      console.log(`   ✓ Found ${pageCarLinks.length} cars on page ${currentPage}`);
      
      if (pageCarLinks.length === 0) {
        console.log(`❌ No cars found on page ${currentPage}, stopping pagination`);
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
        const descEl = document.querySelector('p.description[data-testid="at-show-product-description-text"], .description, [class*="description"]');
        
        // Get all listing images from the gallery
        const imageGallery = [];
        const seen = new Set();
        
        // Strategy 1: Look for images in the gallery/swiper component
        const galleryContainer = document.querySelector('qs-show-product-gallery, [class*="gallery"], .swiper');
        
        if (galleryContainer) {
          // Get images with data-testid attribute (most reliable)
          const testIdImages = galleryContainer.querySelectorAll('img[data-testid*="gallery"]');
          testIdImages.forEach(img => {
            let src = img.src || img.dataset.src || img.getAttribute('data-src');
            // Convert thumb to full size
            if (src && src.includes('productimages')) {
              src = src.replace('_thumb.webp', '.webp');
              if (!seen.has(src)) {
                seen.add(src);
                imageGallery.push(src);
              }
            }
          });
          
          // If no testid images, look for all images in gallery that match product pattern
          if (imageGallery.length === 0) {
            const allGalleryImages = galleryContainer.querySelectorAll('img');
            allGalleryImages.forEach(img => {
              let src = img.src || img.dataset.src || img.getAttribute('data-src');
              // Only include productimages URLs
              if (src && src.includes('productimages') && src.includes('media-blob.qatarsale.com')) {
                src = src.replace('_thumb.webp', '.webp');
                if (!seen.has(src)) {
                  seen.add(src);
                  imageGallery.push(src);
                }
              }
            });
          }
        }
        
        // Strategy 2: If still no images, look for swiper slides specifically
        if (imageGallery.length === 0) {
          const swiperSlides = document.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate) img');
          swiperSlides.forEach(img => {
            let src = img.src || img.dataset.src;
            if (src && src.includes('productimages')) {
              src = src.replace('_thumb.webp', '.webp');
              if (!seen.has(src)) {
                seen.add(src);
                imageGallery.push(src);
              }
            }
          });
        }
        
        return {
          description: descEl?.innerText?.trim() || "",
          listingImages: imageGallery
        };
      });
      
      let whatsappPhone = "";
      
      // Click Call Now button to get phone
      try {
        const callSelector = 'a.phone[data-testid="at-show-product-info-increaseCount-button"], a.phone';
        await page.waitForSelector(callSelector, { timeout: 3000 });
        
        await page.click(callSelector);
        console.log(`      📞 Clicked Call button, waiting for number...`);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Check if a modal/overlay appeared with the phone number
        const phoneData = await page.evaluate(() => {
          // Look for tel: links
          const telLinks = document.querySelectorAll('a[href^="tel:"]');
          if (telLinks.length > 0) {
            return telLinks[0].href.replace('tel:', '');
          }
          
          // Look for phone numbers in modals/overlays
          const overlays = document.querySelectorAll('.cdk-overlay-container, .modal, [role="dialog"], .popup');
          for (const overlay of overlays) {
            const text = overlay.innerText;
            const phoneMatch = text.match(/(\+?\d{3,4}[\s\-]?\d{3,4}[\s\-]?\d{4})/);
            if (phoneMatch) return phoneMatch[1];
          }
          
          return "";
        });
        
        console.log(`      📱 Found phone: ${phoneData}`);
        
        if (phoneData) {
          whatsappPhone = phoneData.replace(/\s/g, '').replace(/^:+/, '');
        }
      } catch (err) {
        console.log(`      ⚠️ Call button not found: ${err.message}`);
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
  
  const SPREADSHEET_ID = '1XgaKVZnNwciYOjU8XYGVaIy8vtKPSdip1U6sWbTcpoc';
  
  // Prepare headers
  const headers = [
    'Brand', 'Model', 'Variant', 'Title', 'Price', 'Price Value', 'Currency',
    'Condition', 'Seller Type', 'Views', 'Year', 'Gear Type', 'Cylinder', 
    'Mileage', 'Description', 'Phone', 'Thumbnail Image', 'Listing Images', 'URL'
  ];
  
  // Prepare rows
  const rows = cars.map(car => [
    car.brand || '',
    car.model || '',
    car.variant || '',
    car.title || '',
    car.price || '',
    car.priceValue || '',
    car.priceCurrency || '',
    car.condition || '',
    car.sellerType || '',
    car.views || 0,
    car.specs?.Year || '',
    car.specs?.['Gear Type'] || '',
    car.specs?.Cylinder || '',
    car.specs?.Mileage || '',
    car.description || '',
    car.phone || '',
    car.image || '',
    car.listingImages ? car.listingImages.join(' | ') : '',
    car.url || ''
  ]);
  
  // Clear existing data
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A1:Z',
    });
  } catch (err) {
    console.log('⚠️ Could not clear sheet (might be empty)');
  }
  
  // Write new data
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'A1',
    valueInputOption: 'RAW',
    resource: {
      values: [headers, ...rows],
    },
  });
}

async function sendDiscordNotification(count) {
  const webhookUrl = 'https://discord.com/api/webhooks/1430798084702470216/VhcKDrQVPNdunBSIJpBrgyIUJSfeY9twMSxSYljSWGdN1VD3M8fkgKjYNrmczjn9rH9v';
  const message = `${count} items pushed successfully`;

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

scrapeQatarSale().catch(console.error);
