// Eat Me First pod - ESP32 + temperature/humidity sensor + 16x2 LCD + RGB LED, connected to the app over WiFi.
//
// Every 5 s: read sensors -> send to the app -> the app replies with what the LCD should show
// (where the pod is, what to eat first, alerts, weekly score) and an urgency level for the status LED.
// If WiFi or the app is down, the LCD shows the pod's own readings instead.
// Serial Monitor at 115200 baud shows everything that happens.
//
// WiFi setup (no password in the code): on first start the pod makes a hotspot "EatMeFirst-Setup".
// Join it from your phone, pick your WiFi, type the password. The pod remembers it.
// To switch WiFi later: hold the BOOT button while pressing EN/RESET (keep BOOT held ~3 s after).
//
// Libraries (Arduino IDE -> Library Manager):
//   "DHT sensor library" + "Adafruit Unified Sensor" (Adafruit), "WiFiManager" (tzapu),
//   "LiquidCrystal" (Arduino) for a bare LCD, or "LiquidCrystal I2C" (Frank de Brabander) for an I2C backpack
//   DS18B20 fallback only: "OneWire" + "DallasTemperature"

// ======== SETTINGS ========
// Quick option: type your WiFi (or phone hotspot) here and the pod connects straight to it.
// Leave both "" to set WiFi up from your phone instead (the "EatMeFirst-Setup" hotspot, see above).
// Must be 2.4 GHz (iPhone hotspot: turn on "Maximize Compatibility").
const char* WIFI_SSID     = "";
const char* WIFI_PASSWORD = "";
// Your app's address + /api/pod/reading
const char* SERVER_URL    = "https://eat-me-first-xjwe.onrender.com/api/pod/reading";
// Must match POD_KEY on the server (Render -> Environment). Leave "" if the server has no POD_KEY.
const char* POD_KEY       = "";
// ==========================

#define USE_DS18B20 0   // 0 = DHT11/DHT22 module, 1 = DS18B20 fallback
#define DHT_TYPE DHT11  // 37-in-1 sensor kit module (KY-015) is a DHT11; change to DHT22 if you have one

// Which LCD you have:
//   1 = bare 16-pin LCD (pins labelled VSS VDD V0 RS RW E D0-D7 A K), wired in 4-bit mode (6 pins).
//   0 = LCD with an I2C backpack (4 pins: GND VCC SDA SCL).
#define LCD_PARALLEL 1

// Pins are picked automatically for the board you compile for (Tools -> Board).
// Arduino.h must come first: it's what defines which chip we're building for.
#include <Arduino.h>
#include "esp_system.h"
#if CONFIG_IDF_TARGET_ESP32S3
  #define BOARD_S3 1
#else
  #define BOARD_S3 0
#endif
// RGB LED fits everywhere except a classic ESP32 wired on one side with a bare LCD (not enough pins):
// there it falls back to a single status LED on GPIO 12.
#define USE_RGB (BOARD_S3 || !LCD_PARALLEL)

#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#if LCD_PARALLEL
  #include <LiquidCrystal.h>
#else
  #include <Wire.h>
  #include <LiquidCrystal_I2C.h>
#endif
#if USE_DS18B20
  #include <OneWire.h>
  #include <DallasTemperature.h>
#else
  #include <DHT.h>
#endif

#if BOARD_S3
// ESP32-S3 DevKit: everything on the header side 3V3, RST, 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9 ... 13, 5V
// (GPIO 3 and 46 are skipped: the chip reads them at power-up. Analog needs GPIO 1-10 = ADC1.)
const int TEMP_PIN = 6;    // DHT11 module "S"
const int RGB_R = 7, RGB_G = 15, RGB_B = 16;
#if LCD_PARALLEL
const int LCD_RS = 17, LCD_E = 18, LCD_D4 = 8, LCD_D5 = 9, LCD_D6 = 10, LCD_D7 = 11;
#else
const int LCD_SDA = 17, LCD_SCL = 18;
#endif
const int LED_PIN  = -1;   // the S3 DevKit's onboard LED is a NeoPixel; not used
#else
// Classic ESP32 DevKit: everything on the 3V3 ... GPIO 13 side
#if LCD_PARALLEL
const int LCD_RS = 32, LCD_E = 33, LCD_D4 = 25, LCD_D5 = 26, LCD_D6 = 27, LCD_D7 = 14;
const int TEMP_PIN   = 13; // DHT data
// Single status LED (+ 220 ohm resistor, other leg to GND). GPIO 12 must be LOW at power-up or the
// ESP32 won't boot; an LED wired to GND keeps it low, so it's safe here (never put a pull-up on it).
const int STATUS_LED = 12;
#else
const int TEMP_PIN = 14;   // DHT data
const int LCD_SDA  = 32, LCD_SCL = 33;
const int RGB_R = 25, RGB_G = 26, RGB_B = 27;
#endif
const int LED_PIN  = 2;    // onboard blue LED
#endif

// RGB LED module (pins R G B -): "-" to GND = common cathode. Set true if its common pin goes to 3V3.
const bool RGB_COMMON_ANODE = false;
const int SETUP_BUTTON_PIN = 0;    // the BOOT button: hold it at start-up to set up WiFi again
const char* SETUP_HOTSPOT = "EatMeFirst-Setup";

const unsigned long SEND_INTERVAL_MS   = 5000;     // one reading every 5 s
const unsigned long SCREEN_INTERVAL_MS = 3000;     // next LCD screen every 3 s
const int MAX_SCREENS = 8;

#if USE_DS18B20
OneWire oneWire(TEMP_PIN);
DallasTemperature ds(&oneWire);
#else
DHT dht(TEMP_PIN, DHT_TYPE);
#endif

#if LCD_PARALLEL
LiquidCrystal lcdPar(LCD_RS, LCD_E, LCD_D4, LCD_D5, LCD_D6, LCD_D7);
LiquidCrystal* lcd = nullptr;       // a bare LCD can't be detected, so it's always "there"
#else
LiquidCrystal_I2C* lcd = nullptr;   // created once we know its I2C address (found by scanning)
#endif

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

// ---------- Status LED ----------
#if !USE_RGB
// One LED: off = all good, on = eat something soon, fast blink = act now, slow blink = offline
void rgb(int r, int g, int b) { digitalWrite(STATUS_LED, (r || g || b) ? HIGH : LOW); }

void updateRgb() {
  unsigned long t = millis();
  switch (level) {
    case GREEN:   rgb(0, 0, 0); break;
    case YELLOW:  rgb(1, 1, 1); break;
    case RED:     rgb((t / 150) % 2, 0, 0); break;
    case OFFLINE: rgb((t / 1000) % 2, 0, 0); break;
  }
}
#else
// RGB LED: green = all good, yellow = eat something soon, red = act now (blinks on a new alert), blue = offline
void rgb(int r, int g, int b) {
  if (RGB_COMMON_ANODE) { r = 255 - r; g = 255 - g; b = 255 - b; }
  analogWrite(RGB_R, r);
  analogWrite(RGB_G, g);
  analogWrite(RGB_B, b);
}

void updateRgb() {
  bool blinkOff = appAlert && level == RED && (millis() / 400) % 2;
  switch (level) {
    case GREEN:   rgb(0, 160, 0); break;
    case YELLOW:  rgb(255, 110, 0); break;
    case RED:     blinkOff ? rgb(0, 0, 0) : rgb(255, 0, 0); break;
    case OFFLINE: rgb(0, 0, 160); break;
  }
}
#endif

// ---------- LCD ----------
#if LCD_PARALLEL
void setupLcd() {
  lcdPar.begin(16, 2);
  lcd = &lcdPar;
  Serial.printf("Bare LCD on RS=%d E=%d D4-D7=%d,%d,%d,%d (blank? adjust the contrast on V0)\n",
                LCD_RS, LCD_E, LCD_D4, LCD_D5, LCD_D6, LCD_D7);
}
#else
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
#endif

// Flash the screen to grab attention on alerts (backpack: backlight; bare LCD: text on/off)
void flashLcd() {
  if (!lcd) return;
  for (int i = 0; i < 3; i++) {
#if LCD_PARALLEL
    lcd->noDisplay(); delay(150); lcd->display(); delay(150);
#else
    lcd->noBacklight(); delay(150); lcd->backlight(); delay(150);
#endif
  }
}

void show(const String& top, const String& bottom) {
  Serial.printf("[LCD] %-16s | %s\n", top.c_str(), bottom.c_str());
  if (!lcd) return;
  lcd->clear();
  lcd->setCursor(0, 0); lcd->print(top.substring(0, 16));
  lcd->setCursor(0, 1); lcd->print(bottom.substring(0, 16));
}

// What to show when the app can't be reached
void setLocalScreens(const char* why) {
  // Without the app we don't know what's in the fridge: just say why
  screenCount = 0;
  screens[screenCount][0] = "Eat Me First";
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
  if (strlen(WIFI_SSID)) {                     // WiFi typed into the code: just connect
    show("WiFi connecting", WIFI_SSID);
    Serial.printf("Connecting to \"%s\"", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) { delay(500); Serial.print("."); }
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("\nWiFi OK, IP %s\n", WiFi.localIP().toString().c_str());
      show("WiFi connected", WIFI_SSID);
    } else {
      Serial.println("\nWiFi failed - check the name/password and that it's 2.4 GHz");
      show("WiFi failed", "Check name/pass");
    }
    return;
  }
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
  Serial.println("[boot] starting WiFi setup (hotspot if no saved WiFi)...");
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

// Send one reading; the reply (thanks to ?lcd=1) is the LCD text
bool sendReading() {
  String body = "{\"seq\":" + String(seq) +
    ",\"tempC\":" + (isnan(lastTemp) ? String("null") : String(lastTemp, 2)) +
    ",\"humidity\":" + (isnan(lastHum) ? String("null") : String(lastHum, 1)) + "}";

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
  if (LED_PIN < 0) return;
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(80);
    digitalWrite(LED_PIN, LOW);  delay(120);
  }
}

void setup() {
  Serial.begin(115200);
  delay(3000);  // give the USB serial time to connect so the first lines aren't lost
  // Why did we (re)start? 1=power-on 3=software 4=crash 5=deep sleep 6/7=watchdog 9=brownout 11=USB
  Serial.printf("\n[boot] reset reason %d\n", (int)esp_reset_reason());
  if (LED_PIN >= 0) pinMode(LED_PIN, OUTPUT);
#if USE_DS18B20
  ds.begin();
#else
  dht.begin();
#endif
  Serial.println("\n=== Eat Me First pod ===");
#if USE_RGB
  pinMode(RGB_R, OUTPUT); pinMode(RGB_G, OUTPUT); pinMode(RGB_B, OUTPUT);
#else
  pinMode(STATUS_LED, OUTPUT);
#endif
  rgb(255, 255, 255); delay(300);   // quick white flash: LED works
  rgb(0, 0, 160);
  Serial.println("[boot] LCD...");
  setupLcd();
  show("Eat Me First", "Starting...");
  Serial.println("[boot] WiFi...");
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
    seq++;
    Serial.printf("#%lu  temp %.1f C | hum %.0f %%\n", seq, lastTemp, lastHum);

    connectWiFi();
    if (WiFi.status() == WL_CONNECTED) {
      appReachable = sendReading();
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
    if (appAlert && screens[screenIndex][0].startsWith("!!")) flashLcd();
  }
}
