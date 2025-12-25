const fs = require('fs');

function parseLocale(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    const jsonStr = content.substring(start, end + 1);
    // Use a simpler approach to parse the object literal
    try {
        // This is safe since it's our own code
        return eval('(' + jsonStr + ')');
    } catch (e) {
        console.error('Error parsing', filePath, e);
        return {};
    }
}

const en = parseLocale('./src/locales/en.js');
const zh = parseLocale('./src/locales/zh.js');

const enKeys = Object.keys(en);
const zhKeys = Object.keys(zh);

console.log('Missing in ZH:', JSON.stringify(enKeys.filter(k => !zhKeys.includes(k)), null, 2));
console.log('Missing in EN:', JSON.stringify(zhKeys.filter(k => !enKeys.includes(k)), null, 2));
