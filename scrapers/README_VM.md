# Car Scrapers - VM Setup Guide

This guide shows how to run the car scrapers on a free VM instead of GitHub Actions.

## Quick Start

### 1. Set up your VM
Any Linux VM will work (AWS Free Tier, Google Cloud Free Tier, Oracle Cloud Free Tier, etc.)

### 2. Install Node.js
```bash
# Update package manager
sudo apt update && sudo apt upgrade -y

# Install Node.js (version 18 or higher)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

### 3. Clone and Setup
```bash
# Clone the repository
git clone <your-repo-url>
cd scrapers

# Install dependencies for all scrapers
for dir in */; do
  if [ -f "$dir/package.json" ]; then
    echo "Installing dependencies for $dir"
    cd "$dir"
    npm install
    cd ..
  fi
done
```

### 4. Set Environment Variables
Create a `.env` file in each scraper directory with:
```bash
GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
```

### 5. Run Scrapers

#### Option A: Run All at Once (Recommended)
```bash
# Make the script executable
chmod +x run_all_scrapers.js

# Run all scrapers
node run_all_scrapers.js
```

#### Option B: Run Individual Scrapers
```bash
cd carsemsar && node scraper.js 5 && cd ..
cd oasiscars && node scraper.js 5 && cd ..
cd qatarslae && node scraper.js 5 && cd ..
cd qic-market && node scraper.js 5 && cd ..
cd Qmotors && node scraper.js 5 && cd ..
cd mzad && node scraper.js 5 && cd ..
```

#### Option C: Windows Batch File
```cmd
run_all_scrapers.bat
```

### 6. Set Up Daily Automation

#### Using Cron (Linux/macOS)
```bash
# Make scripts executable
chmod +x run_all_scrapers.js

# Set up cron job to run daily at 3 AM
echo "0 3 * * * cd $(pwd) && node run_all_scrapers.js >> scraper.log 2>&1" | crontab -

# Check cron job
crontab -l
```

#### Using the Setup Script
```bash
chmod +x setup_cron.sh
./setup_cron.sh
```

## File Descriptions

- `run_all_scrapers.js` - Main Node.js script (cross-platform)
- `run_all_scrapers.bat` - Windows batch file
- `setup_cron.sh` - Linux cron setup script
- `scraper.log` - Log file (created automatically)

## Monitoring

### View Logs
```bash
# View recent logs
tail -f scraper.log

# View all logs
cat scraper.log
```

### Check Running Processes
```bash
# Check if scrapers are running
ps aux | grep node

# Kill running scrapers if needed
pkill -f scraper.js
```

## Troubleshooting

### Common Issues

1. **Permission Denied**
   ```bash
   chmod +x run_all_scrapers.js
   chmod +x setup_cron.sh
   ```

2. **Node.js Not Found**
   ```bash
   # Check if Node.js is installed
   which node
   
   # Reinstall if needed
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. **Missing Dependencies**
   ```bash
   # Reinstall dependencies
   for dir in */; do
     if [ -f "$dir/package.json" ]; then
       cd "$dir"
       npm install
       cd ..
     fi
   done
   ```

4. **Environment Variables Not Set**
   - Ensure `.env` files exist in each scraper directory
   - Check that `GOOGLE_SERVICE_ACCOUNT_KEY` and `DISCORD_WEBHOOK_URL` are properly formatted

### Debug Mode
```bash
# Run with debug output
DEBUG=true node run_all_scrapers.js
```

## Free VM Options

### Oracle Cloud Free Tier
- 2 AMD VMs (1GB RAM each)
- Always free
- Good for running scrapers

### Google Cloud Free Tier
- 1 f1-micro instance per month
- 30GB storage
- 1GB RAM

### AWS Free Tier
- 1 t2.micro instance for 12 months
- 30GB storage
- 1GB RAM

### Azure Free Tier
- 750 hours of B1S VM per month for 12 months
- 64GB storage
- 1GB RAM

## Security Notes

1. **Service Account Keys**: Store securely, don't commit to git
2. **VM Security**: Use SSH keys, not passwords
3. **Firewall**: Only allow necessary ports
4. **Updates**: Keep VM updated with security patches

## Cost

All the VM options listed above are free (within their respective free tier limits). The scrapers themselves use minimal resources.

## Support

If you encounter issues:
1. Check the logs: `cat scraper.log`
2. Run individual scrapers to isolate problems
3. Verify environment variables are set correctly
4. Check internet connectivity on the VM