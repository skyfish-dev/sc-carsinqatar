# Car Scrapers Repository

This repository contains multiple web scrapers for extracting car listings from various Qatari automotive websites and pushing the data to Google Sheets.

## Overview

The project includes scrapers for the following websites:

- **carsemsar.com** - Car Sem Sar
- **oasiscars.com** - Oasis Cars
- **qatarslae.com** - Qatar Slae
- **qic-market.com** - QIC Market
- **qmotors.com** - Q Motors
- **mzad.com** - Mzad (Auction site)

## Project Structure

```
scrapers/
├── car-scraper/          # Original car scraper (reference)
├── carsemsar/           # Car Sem Sar scraper
├── oasiscars/           # Oasis Cars scraper
├── qatarslae/           # Qatar Slae scraper
├── qic-market/          # QIC Market scraper
├── Qmotors/             # Q Motors scraper
├── mzad/                # Mzad scraper
├── .github/workflows/   # GitHub Actions workflows
└── README.md            # This file
```

Each scraper directory contains:
- `package.json` - Dependencies and scripts
- `scraper.js` - Main scraper implementation
- `sheet-config.json` - Google Sheets configuration

## Technology Stack

- **Node.js** - Runtime environment
- **Puppeteer** - Web scraping and browser automation
- **Google Sheets API** - Data storage and management
- **GitHub Actions** - Automated daily execution
- **Discord Webhooks** - Notifications

## Setup Instructions

### Prerequisites

1. **Node.js** (version 18 or higher)
2. **GitHub account** with repository access
3. **Google Cloud Platform** project with Google Sheets API enabled
4. **Service Account** with Google Sheets access
5. **Discord webhook URL** (optional, for notifications)

### Local Development

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd scrapers
   ```

2. **Install dependencies for each scraper:**
   ```bash
   # Install for all scrapers
   for dir in */; do
     if [ -f "$dir/package.json" ]; then
       echo "Installing dependencies for $dir"
       cd "$dir"
       npm install
       cd ..
     fi
   done
   ```

3. **Configure Google Sheets:**
   - Each scraper has a `sheet-config.json` file with the Google Sheets ID
   - Ensure your service account has edit access to these sheets
   - The service account key should be provided via environment variable

4. **Set up environment variables:**
   Create a `.env` file or set environment variables:
   ```bash
   GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'
   DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
   ```

5. **Run a scraper locally:**
   ```bash
   cd carsemsar
   node scraper.js 5  # Scrape 5 cars
   ```

### Google Sheets Configuration

Each scraper uses a dedicated Google Sheet. The sheet IDs are stored in `sheet-config.json` files:

- **carsemsar**: Uses environment variable (no config file)
- **oasiscars**: `1TXHzk8AxjCigGVb2Xico59fnauIMDzMtkU4PmB1UEpo`
- **qatarslae**: `1XgaKVZnNwciYOjU8XYGVaIy8vtKPSdip1U6sWbTcpoc`
- **qic-market**: `1Oim8yuFWZs4mRE4XGtoH3Yyxi3C2hpGP0tMydEij2fg`
- **qmotors**: `1pafeffA2SG_eYRFSR2TF14djWDKz5_zftqvZvbzjz00`
- **mzad**: `1IheLoMbpxw1vDNYaZexS7zrL0e01-4KXeLokqU3FYBg`

### Service Account Setup

1. **Create a Google Cloud Project:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable Google Sheets API

2. **Create Service Account:**
   - Navigate to IAM & Admin > Service Accounts
   - Create a new service account
   - Grant it access to Google Sheets API

3. **Generate Key:**
   - Create a JSON key for the service account
   - This key will be used as `GOOGLE_SERVICE_ACCOUNT_KEY`

4. **Share Google Sheets:**
   - Share each Google Sheet with the service account email
   - Grant edit permissions

## GitHub Actions Workflow

The repository includes an automated workflow that runs daily at 3 AM UTC:

### Workflow Features

- **Daily execution** of all scrapers
- **Parallel execution** for optimal performance
- **Error handling** and notifications
- **Discord integration** for status updates

### Workflow Configuration

The workflow is defined in `.github/workflows/all-scrapers.yml`:

```yaml
on:
  schedule:
    - cron: '0 3 * * *'  # Daily at 3 AM UTC
  workflow_dispatch:     # Manual trigger
```

### Environment Variables for GitHub Actions

Set these secrets in your GitHub repository:

1. **GOOGLE_SERVICE_ACCOUNT_KEY**
   - The complete JSON service account key
   - Used by all scrapers for Google Sheets access

2. **DISCORD_WEBHOOK_URL** (optional)
   - Discord webhook for notifications
   - Different webhooks can be used per scraper

### Manual Execution

You can manually trigger the workflow:
1. Go to your repository on GitHub
2. Navigate to Actions tab
3. Select "All Scrapers Daily" workflow
4. Click "Run workflow"

## Usage

### Running Individual Scrapers

Each scraper can be run independently:

```bash
# Navigate to scraper directory
cd carsemsar

# Run with default (5 cars)
node scraper.js

# Run with custom number of cars
node scraper.js 10

# Run with debug mode
DEBUG=true node scraper.js 5
```

### Command Line Arguments

- **First argument**: Number of cars to scrape (default: 5)
- **Environment variables**: Configure Google Sheets and Discord

### Output

Scrapers will:
1. Extract car listings from the target website
2. Validate and clean the data
3. Push new listings to Google Sheets
4. Send notifications via Discord (if configured)
5. Log results and errors

## Monitoring and Maintenance

### Logs and Debugging

- **Console output**: Real-time scraping progress
- **Error screenshots**: Saved for debugging (especially in mzad scraper)
- **Discord notifications**: Success/failure alerts

### Common Issues

1. **Google Sheets Access**
   - Ensure service account has edit permissions
   - Check sheet IDs in config files

2. **Website Changes**
   - Update selectors in scraper.js if site structure changes
   - Test locally before deploying

3. **Rate Limiting**
   - Scrapers include delays to avoid detection
   - Monitor for blocking or CAPTCHAs

### Updates and Maintenance

1. **Regular monitoring** of Discord notifications
2. **Update selectors** if websites change structure
3. **Review logs** for errors or performance issues
4. **Update dependencies** periodically

## Security Considerations

- **Service account keys** are sensitive - store securely
- **GitHub secrets** should be used for sensitive data
- **Limit permissions** to only necessary Google APIs
- **Monitor access** to Google Sheets

## Contributing

1. **Fork the repository**
2. **Create a feature branch**
3. **Make changes and test locally**
4. **Submit a pull request**

## Troubleshooting

### Common Errors

1. **Authentication Failed**
   - Check service account key format
   - Verify Google Sheets sharing permissions

2. **Website Not Found**
   - Check internet connectivity
   - Verify website URLs in scraper.js

3. **Google Sheets Error**
   - Check sheet IDs in config files
   - Verify service account has edit access

### Getting Help

- Check Discord notifications for error details
- Review scraper logs for specific issues
- Test individual scrapers locally
- Verify all configuration files

## License

This project is for internal use and automation purposes. Ensure compliance with:
- Website terms of service
- Google API usage policies
- Local data protection regulations

## Contact

For issues, questions, or improvements:
- Review the code and configuration files
- Check Discord notifications for automated alerts
- Test changes in a development environment first