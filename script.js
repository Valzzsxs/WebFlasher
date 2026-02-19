import { ESPLoader, Transport } from './lib/esptool.js';

// Global Variables
let espLoader = null;
let espTransport = null;
let bw16Port = null;
let bw16Reader = null;
let serialPort = null; // For ESP32 Serial Monitor
let serialReader = null;

// UI Helpers
function log(msg, consoleId) {
    const consoleDiv = document.getElementById(consoleId);
    const time = new Date().toLocaleTimeString();
    consoleDiv.textContent += `[${time}] ${msg}\n`;
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
}

window.switchTab = function(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));

    const tabBtn = document.querySelector(`.tab-btn[onclick="switchTab('${tabName}')"]`);
    if (tabBtn) tabBtn.classList.add('active');

    const section = document.getElementById(`${tabName}-section`);
    if (section) section.classList.add('active');
};

/**
 * Manages ESP32 UI Button States
 * @param {boolean} connected - Whether the ESP32 is connected via esptool
 * @param {boolean} monitoring - Whether the serial monitor is active
 */
function updateEspUI(connected, monitoring = false) {
    const connectBtn = document.getElementById('esp-connect');
    const flashBtn = document.getElementById('esp-flash');
    const eraseBtn = document.getElementById('esp-erase');
    const startMonBtn = document.getElementById('esp-serial-start');
    const stopMonBtn = document.getElementById('esp-serial-stop');

    if (monitoring) {
        connectBtn.disabled = true;
        flashBtn.disabled = true;
        eraseBtn.disabled = true;
        startMonBtn.disabled = true;
        stopMonBtn.disabled = false;
        connectBtn.textContent = "Monitor Active";
    } else if (connected) {
        connectBtn.disabled = true;
        flashBtn.disabled = false;
        eraseBtn.disabled = false;
        startMonBtn.disabled = false;
        stopMonBtn.disabled = true;
        connectBtn.textContent = "Connected";
    } else {
        connectBtn.disabled = false;
        flashBtn.disabled = true;
        eraseBtn.disabled = true;
        startMonBtn.disabled = true;
        stopMonBtn.disabled = true;
        connectBtn.textContent = "Connect";
    }
}

// ================= ESP32 LOGIC =================

document.getElementById('esp-connect').addEventListener('click', async () => {
    try {
        const filters = [
            { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // CP210x
            { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340
            { usbVendorId: 0x303a, usbProductId: 0x1001 }, // Espressif
            { usbVendorId: 0x303a, usbProductId: 0x8002 }, // Espressif
        ];

        const port = await navigator.serial.requestPort({ filters });
        if (!port) return;

        espTransport = new Transport(port, true);

        espLoader = new ESPLoader({
            transport: espTransport,
            baudrate: 115200,
            romBaudrate: 115200,
            debugLogging: false,
            terminal: new EspLoaderTerminal({
                clean: () => document.getElementById('esp-console').textContent = "",
                writeLine: (data) => log(data, 'esp-console'),
                write: (data) => log(data, 'esp-console')
            })
        });

        log("Connecting...", 'esp-console');
        log("Note: If connection fails, hold BOOT button.", 'esp-console');

        try {
            await espLoader.main();
            await espLoader.flashId();

            log(`Connected to ${espLoader.chip.CHIP_NAME}`, 'esp-console');
            updateEspUI(true);
        } catch (err) {
            log(`Connection Error: ${err.message}`, 'esp-console');
            log("Try holding BOOT button while connecting.", 'esp-console');
            await espTransport.disconnect();
            espTransport = null;
            updateEspUI(false);
        }

    } catch (e) {
        log(`Error: ${e.message}`, 'esp-console');
    }
});

document.getElementById('esp-flash').addEventListener('click', async () => {
    const fileInput = document.getElementById('esp-file');
    const offsetInput = document.getElementById('esp-offset');

    if (!fileInput.files.length) {
        alert("Please select a file.");
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
        const data = e.target.result;
        const offset = parseInt(offsetInput.value, 16);

        if (isNaN(offset)) {
            alert("Invalid offset.");
            return;
        }

        try {
            log(`Flashing ${file.name} at ${offsetInput.value}...`, 'esp-console');

            const progressContainer = document.getElementById('esp-progress-container');
            const progressBar = document.getElementById('esp-progress-bar');
            progressContainer.classList.remove('hidden');
            progressBar.style.width = "0%";
            progressBar.textContent = "0%";

            const fileArray = [{ data: data, address: offset }];

            await espLoader.writeFlash({
                fileArray: fileArray,
                flashSize: 'keep',
                eraseAll: false,
                compress: true,
                reportProgress: (fileIndex, written, total) => {
                    const percent = Math.round((written / total) * 100);
                    progressBar.style.width = percent + "%";
                    progressBar.textContent = percent + "%";
                },
                calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)),
            });

            log("Flashing complete! Please RESET the board.", 'esp-console');
        } catch (err) {
            log(`Flash failed: ${err.message}`, 'esp-console');
        }
    };

    reader.readAsBinaryString(file);
});

document.getElementById('esp-erase').addEventListener('click', async () => {
    if (!confirm("Erase entire flash?")) return;

    try {
        log("Erasing flash...", 'esp-console');
        await espLoader.eraseFlash();
        log("Erase complete! Please RESET the board.", 'esp-console');
    } catch (e) {
        log(`Erase failed: ${e.message}`, 'esp-console');
    }
});

document.getElementById('esp-console-clear').addEventListener('click', () => {
    document.getElementById('esp-console').textContent = "";
});

// ================= ESP32 SERIAL MONITOR =================

document.getElementById('esp-serial-start').addEventListener('click', async () => {
    // 1. Clean up existing loader connection to unlock port
    if (espTransport) {
        try {
            await espTransport.disconnect();
            await espTransport.waitForUnlock(1500);
        } catch (e) {
            log(`Disconnect warning: ${e.message}`, 'esp-console');
        }

        if (espTransport.device) {
             serialPort = espTransport.device;
        }
        espTransport = null;
        espLoader = null;
    }

    // 2. Acquire Port
    if (!serialPort) {
        try {
            const filters = [
                { usbVendorId: 0x10c4, usbProductId: 0xea60 },
                { usbVendorId: 0x1a86, usbProductId: 0x7523 },
                { usbVendorId: 0x303a, usbProductId: 0x1001 },
                { usbVendorId: 0x303a, usbProductId: 0x8002 },
            ];
            serialPort = await navigator.serial.requestPort({ filters });
        } catch (e) {
            log("No port selected.", 'esp-console');
            return;
        }
    }

    // 3. Open Port
    try {
        if (!serialPort.readable) {
             await serialPort.open({ baudRate: 115200 });
        }
    } catch (e) {
        if (!e.message.includes("already open")) {
            log(`Monitor Error: ${e.message}`, 'esp-console');
            return;
        }
    }

    log("Serial Monitor Started (115200 baud)", 'esp-console');
    updateEspUI(false, true);

    // 4. Reset Device to run firmware
    try {
        await serialPort.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(r => setTimeout(r, 100));
        await serialPort.setSignals({ dataTerminalReady: true, requestToSend: false });
        await new Promise(r => setTimeout(r, 100));
        await serialPort.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (e) {
        log(`Reset signal warning: ${e.message}`, 'esp-console');
    }

    readSerialLoop();
});

document.getElementById('esp-serial-stop').addEventListener('click', async () => {
    if (serialReader) {
        await serialReader.cancel();
        serialReader = null;
    }
    updateEspUI(false, false);
    log("Serial Monitor Stopped. Connect to flash again.", 'esp-console');
});

async function readSerialLoop() {
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
    serialReader = textDecoder.readable.getReader();

    try {
        while (true) {
            const { value, done } = await serialReader.read();
            if (done) break;
            if (value) log(value, 'esp-console');
        }
    } catch (error) {
        log(`Serial Error: ${error}`, 'esp-console');
    } finally {
        serialReader.releaseLock();
    }
}

class EspLoaderTerminal {
    constructor(callbacks) { this.callbacks = callbacks; }
    clean() { this.callbacks.clean(); }
    writeLine(data) { this.callbacks.writeLine(data); }
    write(data) { this.callbacks.write(data); }
}

// ================= BW16 LOGIC =================

document.getElementById('bw16-connect').addEventListener('click', async () => {
    if (bw16Port) {
        log("Already connected.", 'bw16-console');
        return;
    }

    try {
        const filters = [
            { usbVendorId: 0x10c4, usbProductId: 0xea60 },
            { usbVendorId: 0x1a86, usbProductId: 0x7523 },
            { usbVendorId: 0x0bda }, // Realtek
        ];
        bw16Port = await navigator.serial.requestPort({ filters });
        await bw16Port.open({ baudRate: 115200 });

        log("Port Opened (115200)", 'bw16-console');
        document.getElementById('bw16-connect').textContent = "Connected";
        document.getElementById('bw16-connect').disabled = true;
        document.getElementById('bw16-upload').disabled = false;

        readBW16Loop();

    } catch (e) {
        log(`Connection Error: ${e.message}`, 'bw16-console');
    }
});

async function readBW16Loop() {
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = bw16Port.readable.pipeTo(textDecoder.writable);
    bw16Reader = textDecoder.readable.getReader();

    try {
        while (true) {
            const { value, done } = await bw16Reader.read();
            if (done) break;
            if (value) log(value, 'bw16-console');
        }
    } catch (error) {
        log(`Read Error: ${error}`, 'bw16-console');
    } finally {
        bw16Reader.releaseLock();
    }
}

document.getElementById('bw16-upload').addEventListener('click', async () => {
    const fileInput = document.getElementById('bw16-file');
    if (!fileInput.files.length) {
        alert("Please select a file.");
        return;
    }

    if (!confirm("Start Raw Upload? (Ensure device is in Download Mode)")) return;

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
        const data = e.target.result;

        if (!bw16Port || !bw16Port.writable) {
            log("Port not writable.", 'bw16-console');
            return;
        }

        const writer = bw16Port.writable.getWriter();
        const uint8Array = new Uint8Array(data);
        const chunkSize = 256;

        log(`Uploading ${file.name} (${uint8Array.length} bytes)...`, 'bw16-console');

        try {
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
                const chunk = uint8Array.slice(i, i + chunkSize);
                await writer.write(chunk);
                log(`Sent ${i + chunk.length}/${uint8Array.length} bytes`, 'bw16-console');
                await new Promise(r => setTimeout(r, 50));
            }
            log("Upload finished.", 'bw16-console');
        } catch (err) {
            log(`Upload Error: ${err.message}`, 'bw16-console');
        } finally {
            writer.releaseLock();
        }
    };

    reader.readAsArrayBuffer(file);
});

document.getElementById('bw16-console-clear').addEventListener('click', () => {
    document.getElementById('bw16-console').textContent = "";
});
