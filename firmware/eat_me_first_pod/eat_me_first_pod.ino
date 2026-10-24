// Eat Me First pod - ESP32 + sensors + 16x2 LCD, connected to the app over WiFi.
//
// Every 5 s: read sensors -> send to the app -> the app replies with what the LCD should show
// (where the pod is, what to eat first, alerts, weekly score) and the urgency level for the RGB LED:
// green = all good, yellow = eat something soon, red = act now (blinks on a new alert), blue = offline.
// If WiFi or the app is down, the LCD shows the pod's own readings instead.
// Serial Monitor at 115200 baud shows everything that happens.
//
// WiFi setup (no password in the code): on first start the pod makes a hotspot "EatMeFirst-Setup".
// Join it from your phone, pick your WiFi, type the password. The pod remembers it.
// To switch WiFi later: hold the BOOT button while pressing EN/RESET (keep BOOT held ~3 s after).
//
// Libraries (Arduino IDE -> Library Manager):
//   "DHT sensor library" + "Adafruit Unified Sensor" (Adafruit), "LiquidCrystal I2C" (Frank de Brabander),
//   "WiFiManager" (tzapu)
//   DS18B20 fallback only: "OneWire" + "DallasTemperature"

// ======== SETTINGS ========
// (WiFi is set up from your phone - see above)
// Your app's address + /api/pod/reading
const char* SERVER_URL    = "https://eat-me-first-xjwe.onrender.com/api/pod/reading";
// Must match POD_KEY on the server (Render -> Environment). Leave "" if the server has no POD_KEY.
const char* POD_KEY       = "";
// ==========================

#define USE_DS18B20 0   // 0 = DHT22, 1 = DS18B20 fallback

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#if USE_DS18B20
  #include <OneWire.h>
  #include <DallasTemperature.h>
#else
  #include <DHT.h>
#endif

// All parts use the pins on ONE side of the ESP32 DevKit (the 3V3 ... GPIO 13 side).
// GPIO 12 is left free on purpose: if it's pulled high at power-up the ESP32 won't boot.
const int TEMP_PIN = 14;   // DHT22 / DS18B20 data
const int GAS_PIN  = 34;   // MQ-3 AO via voltage divider (ADC1 - works while WiFi is on)
const int LCD_SDA  = 32;   // LCD I2C backpack SDA
const int LCD_SCL  = 33;   // LCD I2C backpack SCL
const int LED_PIN  = 2;    // onboard LED on most ESP32 dev boards
const int SETUP_BUTTON_PIN = 0;    // the BOOT button: hold it at start-up to set up WiFi again
const char* SETUP_HOTSPOT = "EatMeFirst-Setup";

// RGB status LED (each colour leg through a 220 ohm resistor)
const int RGB_R = 25, RGB_G = 26, RGB_B = 27;
const bool RGB_COMMON_ANODE = false;  // true if the LED's long leg goes to 3V3 instead of GND

const unsigned long SEND_INTERVAL_MS   = 5000;     // one reading every 5 s
const unsigned long SCREEN_INTERVAL_MS = 3000;     // next LCD screen every 3 s
const unsigned long GAS_WARMUP_MS      = 180000;   // MQ-3 heater needs ~3 min before readings mean anything
const int MAX_SCREENS = 8;

#if USE_DS18B20
OneWire oneWire(TEMP_PIN);
DallasTemperature ds(&oneWire);
#else
DHT dht(TEMP_PIN, DHT22);
#endif

LiquidCrystal_I2C* lcd = nullptr;   // created once we know its I2C address (found by scanning)

// Screens to cycle through: [i][0] = top line, [i][1] = bottom line
String screens[MAX_SCREENS][2];
int screenCount = 0;
int screenIndex = 0;
bool appAlert = false;
enum Level { GREEN, YELLOW, RED, OFFLINE };
Level level = OFFLINE;
bool appReachable = false;
unsigned long seq = 0;
float lastTemp = NAN, lastHum = NAN;
int lastGas = 0;

// ---------- RGB LED ----------
void rgb(int r, int g, int b) {
  if (RGB_COMMON_ANODE) { r = 255 - r; g = 255 - g; b = 255 - b; }
  analogWrite(RGB_R, r);
  analogWrite(RGB_G, g);
  analogWrite(RGB_B, b);
}

// Steady colour for the level; red blinks while there's a fresh alert
void updateRgb() {
  bool blinkOff = appAlert && level == RED && (millis() / 400) % 2;
  switch (level) {
    case GREEN:   rgb(0, 160, 0); break;
    case YELLOW:  rgb(255, 110, 0); break;
    case RED:     blinkOff ? rgb(0, 0, 0) : rgb(255, 0, 0); break;
    case OFFLINE: rgb(0, 0, 160); break;
  }
}

// ---------- LCD ----------
bool i2cDevice(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void setupLcd() {
  Wire.begin(LCD_SDA, LCD_SCL);
  // I2C backpacks (PCF8574 / PCF8574A) sit at 0x20-0x27 or 0x38-0x3F; 0x27 and 0x3F are the usual ones
  uint8_t addr = 0;
  const uint8_t preferred[] = {0x27, 0x3F};
  for (uint8_t a : preferred) if (!addr && i2cDevice(a)) addr = a;
  for (uint8_t a = 0x20; !addr && a <= 0x3F; a++) {
    if ((a <= 0x27 || a >= 0x38) && i2cDevice(a)) addr = a;
  }
  if (!addr) {
    Serial.printf("No LCD found on I2C - check SDA=GPIO %d, SCL=GPIO %d, VCC=5V, GND. Running without it.\n", LCD_SDA, LCD_SCL);
    return;
  }
  lcd = new LiquidCrystal_I2C(addr, 16, 2);
  lcd->init();
  lcd->backlight();
  Serial.printf("LCD found at 0x%02X\n", addr);
}

void show(const String& top, const String& bottom) {
  Serial.printf("[LCD] %-16s | %s\n", top.c_str(), bottom.c_str());
  if (!lcd) return;
  lcd->clear();
  lcd->setCursor(0, 0); lcd->print(top.substring(0, 16));
  lcd->setCursor(0, 1); lcd->print(bottom.substring(0, 16));
}

// What to show when the app can't be reached: the pod's own readings
void setLocalScreens(const char* why) {
  screenCount = 0;
  screens[screenCount][0] = isnan(lastTemp) ? "Temp: sensor?" : "Temp " + String(lastTemp, 1) + "C";
  screens[screenCount][1] = isnan(lastHum) ? "" : "Humidity " + String(lastHum, 0) + "%";
  screenCount++;
  screens[screenCount][0] = millis() < GAS_WARMUP_MS ? "Gas: warming up" : "Gas level " + String(lastGas);
  screens[screenCount][1] = why;
  screenCount++;
  appAlert = false;
  level = OFFLINE;
}

// App reply: line 1 = "ALERT" or "OK", then 2 lines per screen
void setScreensFromApp(const String& body) {
  int count = 0, start = 0;
  String lines[1 + MAX_SCREENS * 2];
  while (start <= (int)body.length() && count < 1 + MAX_SCREENS * 2) {
    int end = body.indexOf('\n', start);
    if (end < 0) end = body.length();
    lines[count++] = body.substring(start, end);
    start = end + 1;
  }
  if (count < 3) return;  // nothing useful
  // First line: "<GREEN|YELLOW|RED> <ALERT|OK>"
  appAlert = lines[0].endsWith("ALERT");
  level = lines[0].startsWith("RED") ? RED : lines[0].startsWith("YELLOW") ? YELLOW : GREEN;
  screenCount = 0;
  for (int i = 1; i + 1 < count && screenCount < MAX_SCREENS; i += 2) {
    screens[screenCount][0] = lines[i];
    screens[screenCount][1] = lines[i + 1];
    screenCount++;
  }
}

// ---------- Sensors + WiFi ----------
// First time (or after a WiFi reset): open the "EatMeFirst-Setup" hotspot until WiFi is configured
void setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFiManager wm;
  pinMode(SETUP_BUTTON_PIN, INPUT_PULLUP);
  delay(50);
  if (digitalRead(SETUP_BUTTON_PIN) == LOW) {          // BOOT held at start-up -> forget the saved WiFi
    unsigned long held = millis();
    show("Keep holding", "to reset WiFi...");
    while (digitalRead(SETUP_BUTTON_PIN) == LOW && millis() - held < 3000) delay(10);
    if (millis() - held >= 3000) {
      wm.resetSettings();
      show("WiFi forgotten", "Starting setup");
      delay(1500);
    }
  }
  wm.setConfigPortalTimeout(300);              // give up after 5 min, keep working offline, retry later
  wm.setAPCallback([](WiFiManager*) {
    Serial.printf("Setup hotspot open: join \"%s\" from your phone, then pick your WiFi\n", SETUP_HOTSPOT);
    show("Join WiFi from", SETUP_HOTSPOT);
    rgb(160, 0, 160);                           // purple = waiting for WiFi setup
  });
  show("Eat Me First", "WiFi connecting");
  if (wm.autoConnect(SETUP_HOTSPOT)) {
    Serial.printf("WiFi OK (%s), IP %s\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
    show("WiFi connected", WiFi.SSID());
  } else {
    Serial.println("WiFi setup timed out - running offline; restart the pod to try again.");
    show("No WiFi set up", "Restart to retry");
  }
}

// Later drops: quietly reconnect to the saved network
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  static unsigned long lastTry = 0;
  if (lastTry && millis() - lastTry < 15000) return;   // don't hammer the router
  lastTry = millis();
  Serial.println("WiFi lost - reconnecting...");
  WiFi.reconnect();
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) delay(250);
  Serial.println(WiFi.status() == WL_CONNECTED ? "WiFi back" : "Still no WiFi");
}

int readGasRaw() {
  long sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(GAS_PIN); delay(5); }
  return sum / 16;
}

// Send one reading; the reply (thanks to ?lcd=1) is the LCD text
bool sendReading(bool gasReady) {
  String body = "{\"seq\":" + String(seq) +
    ",\"tempC\":" + (isnan(lastTemp) ? String("null") : String(lastTemp, 2)) +
    ",\"humidity\":" + (isnan(lastHum) ? String("null") : String(lastHum, 1)) +
    ",\"gas\":" + (gasReady ? String(lastGas) : String("null")) + "}";

  WiFiClientSecure client;
  client.setInsecure();   // hackathon shortcut: skip certificate checks (traffic is still encrypted)
  HTTPClient http;
  http.setTimeout(15000); // the free server can take a while to wake up
  if (!http.begin(client, String(SERVER_URL) + "?lcd=1")) return false;
  http.addHeader("Content-Type", "application/json");
  if (strlen(POD_KEY)) http.addHeader("X-Pod-Key", POD_KEY);
  int code = http.POST(body);
  String reply = code > 0 ? http.getString() : "";
  http.end();
  Serial.printf("  -> sent %s, server replied %d\n", body.c_str(), code);

  if (code == 200) {
    setScreensFromApp(reply);
    return true;
  }
  setLocalScreens(code == 401 ? "Wrong POD_KEY" : "App offline");
  return false;
}

void blink(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(80);
    digitalWrite(LED_PIN, LOW);  delay(120);
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  pinMode(LED_PIN, OUTPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(GAS_PIN, ADC_11db);
#if USE_DS18B20
  ds.begin();
#else
  dht.begin();
#endif
  Serial.println("\n=== Eat Me First pod ===");
  pinMode(RGB_R, OUTPUT); pinMode(RGB_G, OUTPUT); pinMode(RGB_B, OUTPUT);
  rgb(255, 255, 255); delay(300);   // quick white flash: LED works
  rgb(0, 0, 160);
  setupLcd();
  show("Eat Me First", "Starting...");
  setupWiFi();
  setLocalScreens("Connecting app");
}

void loop() {
  static unsigned long lastSend = 0, lastScreen = 0;
  updateRgb();

  if (millis() - lastSend >= SEND_INTERVAL_MS || lastSend == 0) {
    lastSend = millis();
#if USE_DS18B20
    ds.requestTemperatures();
    lastTemp = ds.getTempCByIndex(0);
    if (lastTemp == DEVICE_DISCONNECTED_C) lastTemp = NAN;
#else
    lastTemp = dht.readTemperature();
    lastHum = dht.readHumidity();
#endif
    lastGas = readGasRaw();
    bool gasReady = millis() > GAS_WARMUP_MS; // don't let warm-up drift become the "normal" gas level
    seq++;
    Serial.printf("#%lu  temp %.1f C | hum %.0f %% | gas %d%s\n", seq, lastTemp, lastHum, lastGas, gasReady ? "" : " (warming up)");

    connectWiFi();
    if (WiFi.status() == WL_CONNECTED) {
      appReachable = sendReading(gasReady);
      blink(appReachable ? 1 : 2);   // 1 blink = sent, 2 = app problem
    } else {
      setLocalScreens("No WiFi");
      blink(3);
    }
  }

  // Cycle the LCD screens; flash the backlight on alerts
  if (millis() - lastScreen >= SCREEN_INTERVAL_MS && screenCount > 0) {
    lastScreen = millis();
    screenIndex = (screenIndex + 1) % screenCount;
    show(screens[screenIndex][0], screens[screenIndex][1]);
    if (lcd && appAlert && screens[screenIndex][0].startsWith("!!")) {
      for (int i = 0; i < 3; i++) { lcd->noBacklight(); delay(150); lcd->backlight(); delay(150); }
    }
  }
}
