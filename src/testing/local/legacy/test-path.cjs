const { join } = require('path');
const { existsSync, readdirSync } = require('fs');

const __dirname_compiled = 'E:\\predict-tradingbot\\bot\\dist\\dashboard';
const FRONT_PREVIEW = join(__dirname_compiled, '..', '..', '..', 'front', 'preview.html');
const FRONT_PREVIEW_DIR = join(__dirname_compiled, '..', '..', '..', 'front', 'preview');

console.log('=== Preview path check ===');
console.log('__dirname:', __dirname_compiled);
console.log('FRONT_PREVIEW:', FRONT_PREVIEW);
console.log('Exists:', existsSync(FRONT_PREVIEW));

if (existsSync(FRONT_PREVIEW_DIR)) {
    console.log('Preview files:', readdirSync(FRONT_PREVIEW_DIR));
}
