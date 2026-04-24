const path = require('path');
const addonPath = path.join(__dirname, '..', 'build', 'Release', 'wstp_addon.node');
const wstp = require(addonPath);

const kernelPath = '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel';
const client = new wstp.WstpClient(kernelPath);
client.start();
setTimeout(() => {
    client.evaluate('"\[Rule]" // ToCharacterCode', (r) => {
        console.log("Rule codepoint:", JSON.stringify(r));
        client.evaluate('ToString[MakeBoxes[a -> b, TraditionalForm], InputForm]', (r2) => {
            console.log("boxStr:", JSON.stringify(r2));
            const s = r2?.value ?? r2;
            // print hex of each character
            if (typeof s === 'string') {
                const buf = Buffer.from(s, 'utf8');
                console.log("hex:", buf.toString('hex'));
            }
            client.stop();
        });
    });
}, 2000);
