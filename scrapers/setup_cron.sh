#!/bin/bash

# Script to set up cron job for running scrapers daily at 3 AM

echo "Setting up daily cron job for car scrapers..."

# Make the Node.js script executable
chmod +x run_all_scrapers.js

# Add cron job to run daily at 3 AM
(crontab -l 2>/dev/null; echo "0 3 * * * cd $(pwd) && node run_all_scrapers.js >> scraper.log 2>&1") | crontab -

echo "Cron job added successfully!"
echo "The scrapers will run daily at 3 AM"
echo "Logs will be saved to scraper.log"
echo ""
echo "To view the cron job:"
echo "crontab -l"
echo ""
echo "To remove the cron job:"
echo "crontab -r"