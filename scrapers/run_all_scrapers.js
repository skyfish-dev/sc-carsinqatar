#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const scrapers = [
  { name: 'CarSemSar', dir: 'carsemsar' },
  { name: 'OasisCars', dir: 'oasiscars' },
  { name: 'QatarSlae', dir: 'qatarslae' },
  { name: 'QIC Market', dir: 'qic-market' },
  { name: 'Q Motors', dir: 'Qmotors' },
  { name: 'Mzad', dir: 'mzad' }
];

async function runScraper(scraper) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== Running ${scraper.name} scraper ===`);
    
    // Check if directory exists
    if (!fs.existsSync(scraper.dir)) {
      console.log(`❌ Directory ${scraper.dir} not found, skipping...`);
      resolve();
      return;
    }
    
    // Check if scraper.js exists
    const scraperPath = path.join(scraper.dir, 'scraper.js');
    if (!fs.existsSync(scraperPath)) {
      console.log(`❌ scraper.js not found in ${scraper.dir}, skipping...`);
      resolve();
      return;
    }
    
    // Change to scraper directory
    const originalDir = process.cwd();
    process.chdir(scraper.dir);
    
    // Run the scraper
    const child = spawn('node', ['scraper.js', '5'], {
      stdio: 'inherit',
      env: { ...process.env }
    });
    
    child.on('close', (code) => {
      process.chdir(originalDir);
      if (code === 0) {
        console.log(`✅ ${scraper.name} scraper completed successfully`);
        resolve();
      } else {
        console.log(`❌ ${scraper.name} scraper failed with code ${code}`);
        resolve(); // Continue with other scrapers even if one fails
      }
    });
    
    child.on('error', (error) => {
      process.chdir(originalDir);
      console.log(`❌ Error running ${scraper.name} scraper:`, error.message);
      resolve();
    });
  });
}

async function main() {
  console.log('🚀 Starting all car scrapers...');
  console.log(`Current directory: ${process.cwd()}`);
  
  for (const scraper of scrapers) {
    await runScraper(scraper);
  }
  
  console.log('\n🎉 All scrapers completed!');
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, exiting...');
  process.exit(0);
});

main().catch(console.error);