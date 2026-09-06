// Bu script GitHub Actions içinde çalışır (bkz. .github/workflows/airtable-sync.yml).
// Görevi: Airtable'daki onaylı kayıtları gizli tutulan bir token ile çekmek,
// ek dosyaları (görsel/prospektüs) indirip repo'ya kaydetmek — çünkü Airtable'ın
// verdiği ek dosya URL'leri yaklaşık 2 saat sonra geçersiz oluyor (bkz. Airtable'ın
// kendi dokümantasyonu: https://support.airtable.com/docs/airtable-attachment-url-behavior)
// — ve sonucu index.html'in okuduğu basit JSON dosyalarına yazmak.
//
// Gerçek Airtable token'ı burada process.env üzerinden okunuyor; kod içinde
// hiçbir yerde yazılı değil ve asla commit edilmiyor.

const fs = require('fs');
const path = require('path');

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;

if (!BASE_ID || !TOKEN) {
  console.error('AIRTABLE_BASE_ID ve AIRTABLE_TOKEN ortam değişkenleri gerekli.');
  console.error('Bunlar GitHub repo Settings > Secrets and variables > Actions altında tanımlanmalı.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Bu çalıştırmada gerçekten kullanılan (referans verilen) dosya adlarını
// topluyoruz ki sonda artık hiçbir kayıtta geçmeyen eski dosyaları
// "data/uploads/" içinden temizleyebilelim (repo'nun sürekli şişmesini önler).
const referencedFilenames = new Set();

async function fetchAllRecords(tableName, formula) {
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}`);
    if (formula) url.searchParams.set('filterByFormula', formula);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) {
      throw new Error(`Airtable isteği başarısız (${tableName}): HTTP ${res.status} - ${await res.text()}`);
    }
    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

function sanitizeFilename(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-');
}

async function localizeAttachments(record, fieldName) {
  const attachments = record.fields[fieldName];
  if (!Array.isArray(attachments)) return;
  for (const att of attachments) {
    const localName = `${att.id}-${sanitizeFilename(att.filename || 'dosya')}`;
    const localPath = path.join(UPLOADS_DIR, localName);
    att.localPath = `data/uploads/${localName}`;
    referencedFilenames.add(localName);
    if (fs.existsSync(localPath)) continue;
    console.log(`İndiriliyor: ${att.filename} (${record.id})`);
    try {
      const res = await fetch(att.url);
      if (!res.ok) {
        console.warn(`  Uyarı: ${att.filename} indirilemedi (HTTP ${res.status}), atlanıyor.`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
    } catch (err) {
      console.warn(`  Uyarı: ${att.filename} indirilirken hata oluştu, atlanıyor.`, err.message);
    }
  }
}

async function processTable(tableName, formula, attachmentField) {
  const records = await fetchAllRecords(tableName, formula);
  if (attachmentField) {
    for (const record of records) {
      await localizeAttachments(record, attachmentField);
    }
  }
  return records;
}

// "data/uploads/" içindeki, artık hiçbir onaylı kayıtta geçmeyen dosyaları siler.
// Sadece bu script tarafından yönetilen klasörde çalışır, başka bir şeye dokunmaz.
function cleanupOrphanedUploads() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const existing = fs.readdirSync(UPLOADS_DIR);
  for (const filename of existing) {
    if (filename === '.gitkeep') continue;
    if (!referencedFilenames.has(filename)) {
      fs.unlinkSync(path.join(UPLOADS_DIR, filename));
      console.log(`Artık kullanılmayan dosya silindi: ${filename}`);
    }
  }
}

async function main() {
  const businesses = await processTable('Isletmeler', "{Durum}='Onaylandı'", 'Gorsel');
  fs.writeFileSync(path.join(DATA_DIR, 'isletmeler.json'), JSON.stringify(businesses, null, 2));
  console.log(`Isletmeler: ${businesses.length} kayıt yazıldı.`);

  const events = await processTable('Etkinlikler', "{Durum}='Onaylandı'", 'Gorsel');
  fs.writeFileSync(path.join(DATA_DIR, 'etkinlikler.json'), JSON.stringify(events, null, 2));
  console.log(`Etkinlikler: ${events.length} kayıt yazıldı.`);

  // Sadece onaylı VE süresi bugün ya da sonrasında biten kampanyalar dahil edilir.
  // BitisTarihi'nin bir gün öncesinden "sonra" olması, bitiş gününün kendisini de kapsar.
  const campaignFormula = "AND({Durum}='Onaylandı', IS_AFTER({BitisTarihi}, DATEADD(TODAY(), -1, 'days')))";
  const campaigns = await processTable('Kampanyalar', campaignFormula, 'Prospektus');
  fs.writeFileSync(path.join(DATA_DIR, 'kampanyalar.json'), JSON.stringify(campaigns, null, 2));
  console.log(`Kampanyalar: ${campaigns.length} kayıt yazıldı.`);

  cleanupOrphanedUploads();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});