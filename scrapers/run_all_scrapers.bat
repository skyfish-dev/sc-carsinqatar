@echo off
echo Starting all car scrapers...

echo.
echo Running CarSemSar scraper...
cd carsemsar
node scraper.js 5
cd ..

echo.
echo Running OasisCars scraper...
cd oasiscars
node scraper.js 5
cd ..

echo.
echo Running QatarSlae scraper...
cd qatarslae
node scraper.js 5
cd ..

echo.
echo Running QIC Market scraper...
cd qic-market
node scraper.js 5
cd ..

echo.
echo Running Q Motors scraper...
cd Qmotors
node scraper.js 5
cd ..

echo.
echo Running Mzad scraper...
cd mzad
node scraper.js 5
cd ..

echo.
echo All scrapers completed!
pause