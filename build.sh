npm run prepare
npm run build-dev
npm run build-prod
npm run build-css

sudo cp ./dist/maplibre-gl.css /var/www/html/mapkin/
sudo cp ./dist/maplibre-gl.mjs /var/www/html/mapkin/
sudo cp ./dist/maplibre-gl.mjs.map /var/www/html/mapkin/
sudo cp ./dist/maplibre-gl-shared.mjs.map /var/www/html/mapkin/
sudo cp ./dist/maplibre-gl-worker.mjs.map /var/www/html/mapkin/
sudo cp ./dist/maplibre-gl-shared.mjs /var/www/html/mapkin/
sudo cp ./dist/maplibre-gl-worker.mjs /var/www/html/mapkin/
