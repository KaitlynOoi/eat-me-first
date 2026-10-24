// Eat Me First pod - Step 1: read sensors and print to Serial Monitor (115200 baud)

#define USE_DS18B20 0   // 0 = DHT22, 1 = DS18B20 fallback

#include <Arduino.h>
#if USE_DS18B20
  #include <OneWire.h>
  #include <DallasTemperature.h>
#else
  #include <DHT.h>
#endif

const int TEMP_PIN = 4;    // DHT22 / DS18B20 data
const int GAS_PIN  = 34;   // MQ-3 AO via voltage divider (ADC1 - still works once WiFi is on)
const int LED_PIN  = 2;    // onboard LED on most ESP32 dev boards

// Divider: AO -> 10k -> GPIO34 -> 20k -> GND, so the pin sees 2/3 of the sensor voltage
const float DIVIDER_RATIO = (10.0 + 20.0) / 20.0;

const unsigned long READ_INTERVAL_MS = 2000;  // DHT22 can't be read faster than every 2 s

#if USE_DS18B20
OneWire oneWire(TEMP_PIN);
DallasTemperature ds(&oneWire);
#else
DHT dht(TEMP_PIN, DHT22);
#endif

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(LED_PIN, OUTPUT);
  analogReadResolution(12);                     // 0-4095
  analogSetPinAttenuation(GAS_PIN, ADC_11db);   // full ~0-3.3 V range

#if USE_DS18B20
  ds.begin();
#else
  dht.begin();
#endif

  Serial.println();
  Serial.println("=== Eat Me First pod - step 1 ===");
  Serial.println("MQ-3 heater needs 2-3 min to warm up; gas values drift until then.");
}

// Average several ADC samples to smooth out noise
void readGas(int &raw, float &pinVolts) {
  const int N = 16;
  long rawSum = 0, mvSum = 0;
  for (int i = 0; i < N; i++) {
    rawSum += analogRead(GAS_PIN);
    mvSum  += analogReadMilliVolts(GAS_PIN);
    delay(5);
  }
  raw = rawSum / N;
  pinVolts = (mvSum / N) / 1000.0;
}

void loop() {
  digitalWrite(LED_PIN, HIGH);

  float tempC;
  float humidity = NAN;
#if USE_DS18B20
  ds.requestTemperatures();
  tempC = ds.getTempCByIndex(0);
  if (tempC == DEVICE_DISCONNECTED_C) tempC = NAN;
#else
  tempC = dht.readTemperature();
  humidity = dht.readHumidity();
#endif

  int gasRaw;
  float gasPinV;
  readGas(gasRaw, gasPinV);
  float gasSensorV = gasPinV * DIVIDER_RATIO;

  if (isnan(tempC)) {
    Serial.print("TEMP READ FAILED (check GPIO4 wiring/pull-up) | ");
  } else {
    Serial.printf("Temp: %.1f C | ", tempC);
  }
  if (!USE_DS18B20) {
    if (isnan(humidity)) Serial.print("Hum: --- | ");
    else Serial.printf("Hum: %.1f %% | ", humidity);
  }
  Serial.printf("Gas raw: %4d | pin: %.2f V | sensor: %.2f V | up: %lus\n",
                gasRaw, gasPinV, gasSensorV, millis() / 1000);

  delay(100);
  digitalWrite(LED_PIN, LOW);
  delay(READ_INTERVAL_MS - 100);
}
