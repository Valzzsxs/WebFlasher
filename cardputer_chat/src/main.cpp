#include <M5Cardputer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#include <AudioGeneratorMP3.h>
#include <AudioOutputI2S.h>
#include <AudioFileSourceHTTPStream.h>

Preferences preferences;
String ssid = "";
String password = "";
String gemini_key = "";

String userInput = "";
bool isProcessing = false;

AudioGeneratorMP3 *mp3;
AudioFileSourceHTTPStream *file;
AudioOutputI2S *out;

String readInput(String prompt, bool isPassword = false) {
    String input = "";
    M5Cardputer.Display.fillScreen(BLACK);
    M5Cardputer.Display.setCursor(0, 0);
    M5Cardputer.Display.setTextColor(GREEN);
    M5Cardputer.Display.println(prompt);

    while(true) {
        M5Cardputer.update();
        if (M5Cardputer.Keyboard.isChange() && M5Cardputer.Keyboard.isPressed()) {
            Keyboard_Class::KeysState status = M5Cardputer.Keyboard.keysState();
            if (status.enter) {
                return input;
            } else if (status.del) {
                if (input.length() > 0) {
                    input.remove(input.length() - 1);
                }
            } else {
                for (auto i : status.word) {
                    input += i;
                }
            }

            M5Cardputer.Display.fillScreen(BLACK);
            M5Cardputer.Display.setCursor(0, 0);
            M5Cardputer.Display.setTextColor(GREEN);
            M5Cardputer.Display.println(prompt);
            M5Cardputer.Display.setTextColor(WHITE);
            if (isPassword) {
                String stars = "";
                for(int i=0; i<input.length(); i++) stars += "*";
                M5Cardputer.Display.println(stars);
            } else {
                M5Cardputer.Display.println(input);
            }
        }
        delay(10);
    }
}

void setupCredentials() {
    preferences.begin("aichat", false);
    ssid = preferences.getString("ssid", "");
    password = preferences.getString("password", "");
    gemini_key = preferences.getString("gemini_key", "");

    M5Cardputer.Display.fillScreen(BLACK);
    M5Cardputer.Display.setCursor(0, 0);
    M5Cardputer.Display.setTextColor(YELLOW);
    M5Cardputer.Display.println("Press DEL in 3s");
    M5Cardputer.Display.println("to reset config");

    long startTime = millis();
    bool resetConfig = false;
    while(millis() - startTime < 3000) {
        M5Cardputer.update();
        if (M5Cardputer.Keyboard.isChange() && M5Cardputer.Keyboard.isPressed()) {
            if (M5Cardputer.Keyboard.keysState().del) {
                resetConfig = true;
                break;
            }
        }
        delay(10);
    }

    if (ssid == "" || gemini_key == "" || resetConfig) {
        ssid = readInput("Enter WiFi SSID:");
        password = readInput("Enter WiFi PASS:");
        gemini_key = readInput("Gemini API Key:", true);

        preferences.putString("ssid", ssid);
        preferences.putString("password", password);
        preferences.putString("gemini_key", gemini_key);
    }
}

void connectWiFi() {
    M5Cardputer.Display.fillScreen(BLACK);
    M5Cardputer.Display.setCursor(0, 0);
    M5Cardputer.Display.setTextColor(YELLOW);
    M5Cardputer.Display.println("Connecting WiFi..");
    M5Cardputer.Display.println(ssid);

    WiFi.begin(ssid.c_str(), password.c_str());
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
        delay(500);
        M5Cardputer.Display.print(".");
        attempts++;
    }
    if (WiFi.status() == WL_CONNECTED) {
        M5Cardputer.Display.println("\nConnected!");
    } else {
        M5Cardputer.Display.println("\nFailed! Resetting.");
        delay(2000);
        ESP.restart();
    }
    delay(1000);
}

String queryGeminiAPI(String text) {
    WiFiClientSecure *client = new WiFiClientSecure;
    if(client) {
        client->setInsecure(); // Disable SSL certificate verification for simplicity
    }

    HTTPClient http;
    String url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + gemini_key;
    http.begin(*client, url);
    http.addHeader("Content-Type", "application/json");

    JsonDocument doc;
    JsonArray contents = doc["contents"].to<JsonArray>();
    JsonObject part = contents.add<JsonObject>();
    JsonArray parts = part["parts"].to<JsonArray>();
    JsonObject textObj = parts.add<JsonObject>();

    textObj["text"] = "Jawab dalam bahasa Indonesia, maksimal 2 kalimat pendek dan lugas: " + text;

    String requestBody;
    serializeJson(doc, requestBody);

    int httpResponseCode = http.POST(requestBody);
    String responseText = "";

    if (httpResponseCode == 200) {
        String response = http.getString();
        JsonDocument resDoc;
        deserializeJson(resDoc, response);
        const char* content = resDoc["candidates"][0]["content"]["parts"][0]["text"];
        responseText = String(content);
        responseText.trim();
    } else {
        responseText = "API Error: " + String(httpResponseCode);
        Serial.println(http.getString());
    }
    http.end();
    delete client;
    return responseText;
}

String urlEncode(String str) {
    String encodedString = "";
    char c;
    char code0;
    char code1;
    for (int i =0; i < str.length(); i++){
      c=str.charAt(i);
      if (c == ' '){
        encodedString+= '+';
      } else if (isalnum(c)){
        encodedString+=c;
      } else{
        code1=(c & 0xf)+'0';
        if ((c & 0xf) >9){
            code1=(c & 0xf) - 10 + 'A';
        }
        c=(c>>4)&0xf;
        code0=c+'0';
        if (c > 9){
            code0=c - 10 + 'A';
        }
        encodedString+='%';
        encodedString+=code0;
        encodedString+=code1;
      }
    }
    return encodedString;
}

void playTTS(String text) {
    if (text.length() > 200) {
        text = text.substring(0, 200);
    }
    String encodedText = urlEncode(text);
    // Use https for google translate as it redirects http to https anyway.
    // However, AudioFileSourceHTTPStream handles redirects but needs https for it to work.
    String url = "https://translate.google.com/translate_tts?ie=UTF-8&tl=id&client=tw-ob&q=" + encodedText;

    audioLogger = &Serial;
    // ESP8266Audio AudioFileSourceHTTPStream doesn't support HTTPS out of the box unless configured?
    // Wait, AudioFileSourcePROGMEM or AudioFileSourceHTTPStream handles HTTPS internally in ESP8266Audio if URL starts with https.
    // ESP8266Audio uses WiFiClientSecure internally if url starts with "https://".
    file = new AudioFileSourceHTTPStream(url.c_str());
    out = new AudioOutputI2S(0, 1);
    out->SetPinout(41, 43, 42); // Cardputer I2S pins for ES8311
    mp3 = new AudioGeneratorMP3();

    mp3->begin(file, out);

    while(mp3->isRunning()) {
        if (!mp3->loop()) mp3->stop();
    }

    delete file;
    delete out;
    delete mp3;
}

void drawUI() {
    M5Cardputer.Display.fillScreen(BLACK);
    M5Cardputer.Display.setCursor(0, 0);
    M5Cardputer.Display.setTextColor(GREEN);
    M5Cardputer.Display.println("--- Gemini Chat ---");
    M5Cardputer.Display.setTextColor(WHITE);
    M5Cardputer.Display.println(userInput);
}

void setup() {
    auto cfg = M5.config();
    M5Cardputer.begin(cfg, true);
    M5Cardputer.Display.setRotation(1);
    M5.Speaker.setVolume(200);

    setupCredentials();
    connectWiFi();
    drawUI();
}

void loop() {
    M5Cardputer.update();
    if (M5Cardputer.Keyboard.isChange() && M5Cardputer.Keyboard.isPressed()) {
        Keyboard_Class::KeysState status = M5Cardputer.Keyboard.keysState();
        if (status.enter) {
            if (userInput.length() > 0) {
                M5Cardputer.Display.fillScreen(BLACK);
                M5Cardputer.Display.setCursor(0, 0);
                M5Cardputer.Display.setTextColor(YELLOW);
                M5Cardputer.Display.println("Thinking...");

                String answer = queryGeminiAPI(userInput);

                M5Cardputer.Display.fillScreen(BLACK);
                M5Cardputer.Display.setCursor(0, 0);
                M5Cardputer.Display.setTextColor(CYAN);
                M5Cardputer.Display.println("Gemini:");
                M5Cardputer.Display.setTextColor(WHITE);
                M5Cardputer.Display.println(answer);

                // Pause M5 Speaker output briefly so I2S takes over
                M5.Speaker.end();
                playTTS(answer);
                M5.Speaker.begin();

                delay(3000);
                userInput = "";
                drawUI();
            }
        } else if (status.del) {
            if (userInput.length() > 0) {
                userInput.remove(userInput.length() - 1);
                drawUI();
            }
        } else {
            for (auto i : status.word) {
                userInput += i;
            }
            drawUI();
        }
    }
}
