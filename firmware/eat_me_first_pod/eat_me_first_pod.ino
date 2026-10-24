// Eat Me First pod - ESP32 + sensors + 16x2 LCD, connected to the app over WiFi.
//
// Every 5 s: read sensors -> send to the app -> the app replies with what the LCD should show
// (where the pod is, what to eat first, alerts, weekly score). The LCD cycles through those screens.
// If WiFi or the app is down, the LCD shows the pod's own readings instead.
// Serial Monitor at 115200 baud shows everything that happens.
//
// Libraries (Arduino IDE -> Library Manager):
//   "DHT sensor library" + "Adafruit Unified Sensor" (Adafruit), "LiquidCrystal I2C" (Frank de Brabander)
//   DS18B20 fallback only: "OneWire" + "DallasTemperature"

// ======== SETTINGS ========
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
// Your app's address + /api/pod/reading
const char* SERVER_URL    = "https://eat-me-first-xjwe.onrender.com/api/pod/reading";
// Must match POD_KEY on the server (Render -> Environment). Leave "" if the server has no POD_KEY.
const char* POD_KEY       = "";
// ==========================

#define USE_DS18B20 0   // 0 = DHT22, 1 = DS18B20 fallback

#include <Arduino.h>
#include <WiFi.h>
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

const int TEMP_PIN = 4;    // DHT22 / DS18B20 data
const int GAS_PIN  = 34;   // MQ-3 AO via voltage divider (ADC1 - works while WiFi is on)
const int LED_PIN  = 2;    // onboard LED on most ESP32 dev boards
// LCD uses the ESP32's default I2C pins: SDA = GPIO 21, SCL = GPIO 22

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

LiquidCrystal_I2C* lcd = nullptr;   // created once we know its I2C address (0x27 or 0x3F)

// Screens to cycle through: [i][0] = top line, [i][1] = bottom line
String screens[MAX_SCREENS][2];
int screenCount = 0;
int screenIndex = 0;
bool appAlert = false;
bool appReachable = false;
unsigned long seq = 0;
float lastTemp = NAN, lastHum = NAN;
int lastGas = 0;

// ---------- LCD ----------
bool i2cDevice(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void setupLcd() {
  Wire.begin();  // SDA 21, SCL 22
  uint8_t addr = i2cDevice(0x27) ? 0x27 : i2cDevice(0x3F) ? 0x3F : 0;
  if (!addr) {
    Serial.println("No LCD found on I2C (checked 0x27 and 0x3F) - check SDA=21, SCL=22, 5V, GND. Running without it.");
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
  appAlert = lines[0] == "ALERT";
  screenCount = 0;
  for (int i = 1; i + 1 < count && screenCount < MAX_SCREENS; i += 2) {
    screens[screenCount][0] = lines[i];
    screens[screenCount][1] = lines[i + 1];
    screenCount++;
  }
}

// ---------- Sensors + WiFi ----------
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  show("Eat Me First", "WiFi connecting");
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi OK, IP %s\n", WiFi.localIP().toString().c_str());
    show("WiFi connected", WiFi.localIP().toString());
  } else {
    Serial.println("\nWiFi failed - check name/password (2.4 GHz networks only). Retrying soon.");
    show("WiFi failed", "Check name/pass");
  }
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
  setupLcd();
  show("Eat Me First", "Starting...");
  connectWiFi();
  setLocalScreens("Connecting app");
}

void loop() {
  static unsigned long lastSend = 0, lastScreen = 0;

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
