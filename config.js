/* ==================================================================
   ไฟล์ตั้งค่าของระบบ  สำหรับร้านเสื้อผ้า DYSHIRO
   ================================================================== */

window.CONFIG = {

  /* ===== ส่งผ่าน Cloudflare Worker  กุญแจอยู่บนเซิร์ฟเวอร์ ===== */
  PROVIDER: "worker",

  // ที่อยู่ Worker ของคุณ (ห้ามมีเครื่องหมาย / ปิดท้าย)
  WORKER_URL: "https://rough-block-b431.aody5890.workers.dev",

  // ไม่ต้องใส่  เว้นว่างไว้  เพราะกุญแจอยู่ที่ Worker แล้ว
  KEY: "",


  /* ===== การค้นหา ===== */

  // เริ่มด้วย local ก่อนเสมอ  แล้วค่อยเปลี่ยนเป็น vector หลังสร้าง vectors.json
  SEARCH_MODE: "local",

  // รุ่นที่ใช้แปลงเวกเตอร์  (ต้องใช้ตัว embed นี้เท่านั้น ห้ามเปลี่ยน)
  EMBED_MODEL: "nvidia/nemotron-3.5-embed-1b:free",

  VECTORS_FILE: "vectors.json",


  /* ===== การตอบคำถาม ===== */

  // ใช้ openrouter/free เพื่อเลือกโมเดลฟรีที่ว่างให้โดยอัตโนมัติ ไม่ติดคิว 429
  MODEL: "openrouter/free",


  /* ===== เอกสาร ===== */

  DOCS_BASE: "docs",

  FILES: [
    "01-about.txt",
    "02-products.txt",
    "03-shipping.txt",
    "04-policy.txt",
    "05-contact.txt",
  ],


  /* ===== ปรับละเอียด  ปกติไม่ต้องแก้ ===== */
  CHUNK_SIZE: 500,
  OVERLAP: 100,
  TOP_K: 3,

};