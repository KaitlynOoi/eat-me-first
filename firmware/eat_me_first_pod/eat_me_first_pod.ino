// Eat Me First pod - Step 2: read sensors and send them to the app over WiFi.
// Serial Monitor at 115200 baud shows every reading and whether it was sent.
//
// Fill in the 4 settings below, upload, done. The app switches from "no pod" to "pod live" by itself.

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
#if USE_DS18B20
  #include <OneWire.h>
  #include <DallasTemperature.h>
#else
  #include <DHT.h>
#endif

const int TEMP_PIN = 4;    // DHT22 / DS18B20 data
const int GAS_PIN  = 34;   // MQ-3 AO via voltage divider (ADC1 - works while WiFi is on)
const int LED_PIN  = 2;    // onboard LED on most ESP32 dev boards

const unsigned long SEND_INTERVAL_MS  = 5000;       // one reading every 5 s
const unsigned long GAS_WARMUP_MS     = 180000;     // MQ-3 heater needs ~3 min before readings mean anything

#if USE_DS18B20
OneWire oneWire(TEMP_PIN);
DallasTemperature ds(&oneWire);
#else
DHT dht(TEMP_PIN, DHT22);
#endif

unsigned long seq = 0;

void blink(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(80);
    digitalWrite(LED_PIN, LOW);  delay(120);
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
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
  } else {
    Serial.println("\nWiFi failed - check name/password (2.4 GHz networks only). Retrying soon.");
  }
}

// Average several ADC samples to smooth out noise
int readGasRaw() {
  long sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(GAS_PIN); delay(5); }
  return sum / 16;
}

bool sendReading(float tempC, float humidity, int gas, bool gasReady) {
  // Build JSON by hand to avoid needing another library
  String body = "{\"seq\":" + String(seq) +
    ",\"tempC\":" + (isnan(tempC) ? String("null") : String(tempC, 2)) +
    ",\"humidity\":" + (isnan(humidity) ? String("null") : String(humidity, 1)) +
    ",\"gas\":" + (gasReady ? String(gas) : String("null")) + "}";

  WiFiClientSecure client;
  client.setInsecure();  // hackathon shortcut: skip certificate checks (traffic is still encrypted)
  HTTPClient http;
  http.setTimeout(15000); // the free server can take a while to wake up
  if (!http.begin(client, SERVER_URL)) return false;
  http.addHeader("Content-Type", "application/json");
  if (strlen(POD_KEY)) http.addHeader("X-Pod-Key", POD_KEY);
  int code = http.POST(body);
  http.end();
  Serial.printf("  -> sent %s, server replied %d\n", body.c_str(), code);
  return code == 200;
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
  Serial.println("\n=== Eat Me First pod - step 2 (WiFi) ===");
  connectWiFi();
}

void loop() {
  static unsigned long lastSend = 0;
  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();

  float tempC, humidity = NAN;
#if USE_DS18B20
  ds.requestTemperatures();
  tempC = ds.getTempCByIndex(0);
  if (tempC == DEVICE_DISCONNECTED_C) tempC = NAN;
#else
  tempC = dht.readTemperature();
  humidity = dht.readHumidity();
#endif
  int gas = readGasRaw();
  bool gasReady = millis() > GAS_WARMUP_MS; // don't let warm-up drift become the "normal" gas level

  seq++;
  Serial.printf("#%lu  temp %.1f C | hum %.0f %% | gas %d%s\n", seq, tempC, humidity, gas, gasReady ? "" : " (warming up)");
  if (isnan(tempC)) Serial.println("  TEMP READ FAILED - check the sensor wiring on GPIO 4");

  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) { blink(3); return; }
  blink(sendReading(tempC, humidity, gas, gasReady) ? 1 : 2); // 1 blink = sent, 2 = server problem
}
