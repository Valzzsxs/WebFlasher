import { ESPLoader, Transport } from './lib/esptool.js';

let espLoader;
let espTransport;
let bw16Port;
let bw16Reader;
let bw16Writer;
let bw16ReadableStreamClosed;
let bw16WritableStreamClosed;

// UI Helpers
function log(msg, consoleId) {
    const consoleDiv = document.getElementById(consoleId);
    consoleDiv.textContent += msg + "\n";
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
}

window.switchTab = function(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));

    // Find button by onclick attribute text which is slightly fragile but works here
    // Better: use data attributes or just querySelector based on index/id.
    // Given the HTML: <button class="tab-btn" onclick="switchTab('bw16')">
    const tabBtn = document.querySelector(`.tab-btn[onclick="switchTab('${tabName}')"]`);
    if (tabBtn) tabBtn.classList.add('active');

    const section = document.getElementById(`${tabName}-section`);
    if (section) section.classList.add('active');
}

// ================= ESP32 LOGIC =================

document.getElementById('esp-connect').addEventListener('click', async () => {
    if (espLoader) {
        log("Already connected.", 'esp-console');
        return;
    }

    try {
        // Filter for common ESP32 USB-to-Serial adapters (optional, helps user select correct port)
        const filters = [
            { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // CP210x
            { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340
            { usbVendorId: 0x303a, usbProductId: 0x1001 }, // Espressif USB
            { usbVendorId: 0x303a, usbProductId: 0x8002 }, // Espressif USB
        ];

        const port = await navigator.serial.requestPort({ filters });

        if (!port) {
            log("No port selected.", 'esp-console');
            return;
        }

        log("Port selected.", 'esp-console');
        espTransport = new Transport(port, true); // Create Transport instance, enable tracing

        // Debug Transport instance
        console.log("Transport:", espTransport);

        espLoader = new ESPLoader({
            transport: espTransport,
            baudrate: 115200,
            romBaudrate: 115200, // Try to sync at lower baudrate first
            debugLogging: false, // Disable verbose debug logging
            terminal: new EspLoaderTerminal({
                clean: () => document.getElementById('esp-console').textContent = "",
                writeLine: (data) => log(data, 'esp-console'),
                write: (data) => log(data, 'esp-console')
            })
        });

        log("Connecting...", 'esp-console');
        log("Note: If connection fails, try holding the BOOT button on your ESP32 while clicking Connect.", 'esp-console');

        try {
            await espLoader.main();
            await espLoader.flashId();

            log("Connected to " + espLoader.chip.CHIP_NAME, 'esp-console');
            document.getElementById('esp-flash').disabled = false;
            document.getElementById('esp-erase').disabled = false;
            document.getElementById('esp-serial-start').disabled = false;
            document.getElementById('esp-connect').textContent = "Connected";
            document.getElementById('esp-connect').disabled = true;
        } catch (err) {
            log("Connection failed: " + err.message, 'esp-console');
            log("Ensure the device is in Bootloader Mode. Hold the BOOT button on the ESP32 while clicking Connect.", 'esp-console');
        }

    } catch (e) {
        log("Error: " + e.message, 'esp-console');
        console.error(e);
    }
});

document.getElementById('esp-flash').addEventListener('click', async () => {
    const fileInput = document.getElementById('esp-file');
    const offsetInput = document.getElementById('esp-offset');

    if (!fileInput.files.length) {
        alert("Please select a file first.");
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
        const data = e.target.result;
        const offset = parseInt(offsetInput.value, 16); // Hex to int

        if (isNaN(offset)) {
            alert("Invalid offset.");
            return;
        }

        try {
            log(`Starting flash of ${file.name} at ${offsetInput.value}...`, 'esp-console');

            // Show progress bar
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

            log("Flashing complete!", 'esp-console');
        } catch (e) {
            log("Flash failed: " + e.message, 'esp-console');
        }
    };

    reader.readAsBinaryString(file);
});

document.getElementById('esp-erase').addEventListener('click', async () => {
    if (!confirm("This will erase the entire flash memory of the ESP32. Are you sure?")) return;

    try {
        log("Erasing flash memory...", 'esp-console');
        await espLoader.eraseFlash();
        log("Flash erase complete!", 'esp-console');
    } catch (e) {
        log("Erase failed: " + e.message, 'esp-console');
    }
});

document.getElementById('esp-console-clear').addEventListener('click', () => {
    document.getElementById('esp-console').textContent = "";
});

document.getElementById('bw16-console-clear').addEventListener('click', () => {
    document.getElementById('bw16-console').textContent = "";
});

// Serial Monitor Logic
let serialReader;
let serialReadableStreamClosed;

let serialPort = null;

document.getElementById('esp-serial-start').addEventListener('click', async () => {
    // If transport is active, we must disconnect it first to release the lock
    if (espTransport) {
        try {
            await espTransport.disconnect();
            await espTransport.waitForUnlock(1500);
        } catch (e) {
            log("Warning: Disconnect failed (port might be closed): " + e.message, 'esp-console');
        }

        // We reuse the port device from the transport if possible
        if (espTransport.device) {
             serialPort = espTransport.device;
        }
        espTransport = null;
        espLoader = null;
    }

    // If we don't have a port (e.g., disconnected fully), request one
    if (!serialPort) {
        try {
            const filters = [
                { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // CP210x
                { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340
                { usbVendorId: 0x303a, usbProductId: 0x1001 }, // Espressif USB
                { usbVendorId: 0x303a, usbProductId: 0x8002 }, // Espressif USB
            ];
            serialPort = await navigator.serial.requestPort({ filters });
        } catch (e) {
            log("No port selected for Serial Monitor.", 'esp-console');
            return;
        }
    }

    try {
        if (serialPort.readable) {
             log("Port is already readable. Closing to ensure clean state.", 'esp-console');
             // If somehow readable but we want to reset params, close it.
             // But usually readable means locked. If it's not locked but open...
             // Let's just try to open if NOT readable.
        } else {
             await serialPort.open({ baudRate: 115200 });
        }
    } catch (e) {
        if (e.message.includes("The port is already open")) {
             // Ignore, we can proceed
        } else {
            log("Error opening port for Serial Monitor: " + e.message, 'esp-console');
            return;
        }
    }

    log("Starting Serial Monitor at 115200 baud...", 'esp-console');
    document.getElementById('esp-serial-start').disabled = true;
    document.getElementById('esp-serial-stop').disabled = false;

    // Disable flash buttons while serial monitor is active to prevent conflicts
    document.getElementById('esp-flash').disabled = true;
    document.getElementById('esp-erase').disabled = true;
    document.getElementById('esp-connect').disabled = true;

    // Reset sequence to boot firmware (Toggle DTR/RTS)
    try {
        await serialPort.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(r => setTimeout(r, 100));
        await serialPort.setSignals({ dataTerminalReady: true, requestToSend: false }); // Reset
        await new Promise(r => setTimeout(r, 100));
        await serialPort.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (e) {
        log("Reset signal warning: " + e.message, 'esp-console');
    }

    readSerialLoop();
});

document.getElementById('esp-serial-stop').addEventListener('click', async () => {
    if (serialReader) {
        await serialReader.cancel();
        serialReader = null;
    }
    document.getElementById('esp-serial-start').disabled = false;
    document.getElementById('esp-serial-stop').disabled = true;
    // Re-enable connect button so user can reconnect for flashing
    document.getElementById('esp-connect').disabled = false;
    document.getElementById('esp-connect').textContent = "Connect";

    log("Serial Monitor stopped. Reconnect to flash again.", 'esp-console');
});

async function readSerialLoop() {
    const textDecoder = new TextDecoderStream();
    serialReadableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
    serialReader = textDecoder.readable.getReader();

    try {
        while (true) {
            const { value, done } = await serialReader.read();
            if (done) {
                break;
            }
            if (value) {
                log(value, 'esp-console');
            }
        }
    } catch (error) {
        log("Serial read error: " + error, 'esp-console');
    } finally {
        serialReader.releaseLock();
    }
}


// Helper for ESPLoader terminal
class EspLoaderTerminal {
    constructor(callbacks) {
        this.callbacks = callbacks;
    }
    clean() { this.callbacks.clean(); }
    writeLine(data) { this.callbacks.writeLine(data); }
    write(data) { this.callbacks.write(data); }
}


// ================= BW16 LOGIC (Raw Serial) =================

document.getElementById('bw16-connect').addEventListener('click', async () => {
    if (bw16Port) {
        log("Already connected.", 'bw16-console');
        return;
    }

    try {
        const filters = [
            { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // CP210x
            { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340
            { usbVendorId: 0x0bda }, // Realtek
        ];
        bw16Port = await navigator.serial.requestPort({ filters });
        await bw16Port.open({ baudRate: 115200 });

        log("Port opened. Baud: 115200", 'bw16-console');
        document.getElementById('bw16-connect').textContent = "Connected";
        document.getElementById('bw16-connect').disabled = true;
        document.getElementById('bw16-upload').disabled = false;

        // Start reading loop
        readBW16Loop();

    } catch (e) {
        log("Connection error: " + e.message, 'bw16-console');
    }
});

async function readBW16Loop() {
    const textDecoder = new TextDecoderStream();
    bw16ReadableStreamClosed = bw16Port.readable.pipeTo(textDecoder.writable);
    bw16Reader = textDecoder.readable.getReader();

    try {
        while (true) {
            const { value, done } = await bw16Reader.read();
            if (done) {
                break;
            }
            if (value) {
                log(value, 'bw16-console');
            }
        }
    } catch (error) {
        log("Read error: " + error, 'bw16-console');
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

    if (!confirm("This will send the raw binary file to the serial port. Ensure the device is in the correct mode (e.g., waiting for XMODEM or raw stream). Continue?")) {
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
        const data = e.target.result; // ArrayBuffer

        if (!bw16Port || !bw16Port.writable) {
            log("Port not writable.", 'bw16-console');
            return;
        }

        // We need to stop the reader loop to prevent locking if we want full control,
        // but for raw writing while reading is active (full duplex), it's okay IF the browser supports it.
        // Usually, separate locks for readable and writable are fine.

        const writer = bw16Port.writable.getWriter();
        const uint8Array = new Uint8Array(data);
        // Use smaller chunks for stability
        const chunkSize = 256;

        log(`Sending ${file.name} (${uint8Array.length} bytes)...`, 'bw16-console');

        try {
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
                const chunk = uint8Array.slice(i, i + chunkSize);
                await writer.write(chunk);
                log(`Sent ${i + chunk.length}/${uint8Array.length} bytes`, 'bw16-console');
                // Increased delay to 50ms to prevent buffer overflow on the device
                await new Promise(r => setTimeout(r, 50));
            }
            log("Upload finished.", 'bw16-console');
        } catch (err) {
            log("Upload error: " + err.message, 'bw16-console');
        } finally {
            writer.releaseLock();
        }
    };

    reader.readAsArrayBuffer(file);
});
