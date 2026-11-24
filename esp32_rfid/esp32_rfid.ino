#include <SPI.h>
#include <MFRC522.h>

#define SS_PIN   5
#define RST_PIN  22

// Hardware SPI Pins for ESP32: SCK=18, MISO=19, MOSI=23, SS=5
MFRC522 rfid(SS_PIN, RST_PIN);

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 2000);

  // Initialize SPI bus with custom pins
  SPI.begin(18, 19, 23, SS_PIN);
  rfid.PCD_Init();

  Serial.println("ESP32_RFID_READY");
}

void loop() {
  // Check if a new card is present
  if (!rfid.PICC_IsNewCardPresent()) {
    delay(50);
    return;
  }

  // Read card serial
  if (!rfid.PICC_ReadCardSerial()) {
    return;
  }

  // Format card UID into uppercase hex string
  String cardUID = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) {
      cardUID += "0";
    }
    cardUID += String(rfid.uid.uidByte[i], HEX);
  }
  cardUID.toUpperCase();

  // Send JSON line over USB Serial for the Node.js / Web backend
  Serial.print("{\"type\":\"RFID_SCAN\",\"uid\":\"");
  Serial.print(cardUID);
  Serial.println("\"}");

  // Also print prefix format for simple line parsing
  Serial.print("RFID:");
  Serial.println(cardUID);

  // Halt PICC to avoid repeated reads
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  delay(1000); // 1-second debounce
}
