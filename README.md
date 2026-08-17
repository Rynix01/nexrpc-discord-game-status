# NexRPC V2

Windows/VDS odaklı, Discord masaüstü istemcisi gerektirmeden kullanıcı hesabı üzerinden Rich Presence yönetmek için hazırlanmış Electron uygulaması.

> **Uyarı:** Discord normal kullanıcı hesaplarının self-bot/otomasyon amaçlı kullanılmasını resmi olarak desteklemez. Bu proje `discord.js-selfbot-v13` kullandığı için hesabın kısıtlanması veya kapatılması riski vardır. Kullanım sorumluluğu kullanıcıya aittir.

## Bu sürümde ne değişti?

- Dışarı açılan HTTP / localhost web paneli **yok**.
- Arayüz Electron içinde yerel `file://` kaynaklarından çalışır.
- Renderer internet erişimi CSP ile kapalıdır (`connect-src 'none'`).
- Renderer'da `nodeIntegration` kapalı, `contextIsolation` açık, sandbox açıktır.
- Token renderer'a geri gönderilmez.
- Token Electron `safeStorage` ile Windows'un işletim sistemi şifrelemesi kullanılarak saklanır.
- Multi-account desteği vardır.
- Hesap başına başlangıç profili atanabilir.
- Playing / Streaming / Listening / Watching / Competing profilleri oluşturulabilir.
- Details, state, large/small image, tooltip, elapsed time ve 2 buton desteklenir.
- Tray'e küçültme, Windows başlangıcı, otomatik reconnect ve watchdog vardır.
- Saat/gün bazlı Scheduler vardır.
- Profil JSON import/export vardır.
- Yerel log ekranı ve `nexrpc.log` dosyası vardır.

## Gereksinimler

- Windows 10/11 veya Windows Server
- Node.js 20+ (sadece kaynak koddan çalıştırmak/build almak için)
- npm

Paketlenen `.exe` kullanıldığında son kullanıcıda Node.js gerekmez.

## En kolay çalıştırma

1. Zip'i çıkart.
2. `START.bat` çalıştır.
3. İlk çalıştırmada `npm install` otomatik yapılır.
4. NexRPC açıldığında **Accounts** bölümünden hesabını ekle.
5. **Profiles** bölümünden bir Presence profili oluştur.
6. Hesaba profili ata ve **Profili Uygula** de.

Alternatif terminal komutları:

```bat
npm install
npm start
```

## Windows EXE / Installer build

`BUILD.bat` çalıştır veya:

```bat
npm install
npm run dist:win
```

Çıktılar `dist/` klasörüne gelir. Yapılandırma hem NSIS installer hem portable x64 build üretir.

## Veriler nerede?

Electron `userData` klasöründe tutulur. Windows'ta tipik olarak:

```text
%APPDATA%\nexrpc-2\
```

Burada:

- `state.json`: hesap metadata'sı, profiller, scheduler ve **şifrelenmiş** token blob'ları
- `nexrpc.log`: çalışma günlükleri

Token düz metin olarak yazılmaz. `safeStorage` kullanılamıyorsa NexRPC yeni token kaydetmeyi reddeder.

## Mimari

```text
Renderer (HTML/CSS/JS)
    │
    │ contextBridge / IPC
    ▼
Electron Main Process
    ├─ safeStorage
    ├─ Tray / Autostart
    ├─ Scheduler / Watchdog
    └─ discord.js-selfbot-v13
           │
           ▼
       Discord Gateway
```

Renderer doğrudan Node.js API'lerine veya Discord tokenına erişemez. Uygulama herhangi bir HTTP sunucusu veya dinleyen TCP portu açmaz.

## Token alma (konsol / manuel yöntem)

Aşağıdaki snippet, Discord web/desktop ortamında geliştirme konsolundan tokeni bulmaya yarayan klasik bir yöntemdir. Kullanıcı sorumluluğu ile ve yalnızca kendi hesabı için kullanılmalıdır.

```js
window.webpackChunkdiscord_app.push([
  [Symbol()],
  {},
  req => {
    if (!req.c) return;
    for (let m of Object.values(req.c)) {
      try {
        if (!m.exports || m.exports === window) continue;
        if (m.exports?.getToken) return copy(m.exports.getToken());
        for (let ex in m.exports) {
          if (m.exports?.[ex]?.getToken && m.exports[ex][Symbol.toStringTag] !== 'IntlMessagesProxy') return copy(m.exports[ex].getToken());
        }
      } catch {}
    }
  },
]);

window.webpackChunkdiscord_app.pop();
console.log('%cHata yok!', 'font-size: 50px');
console.log(`%cToken panoya kopyalandı!`, 'font-size: 16px');
```

### Kullanım

1. Discord uygulamasını aç.
2. F12 ile Geliştirici Araçları'na gir.
3. Konsol sekmesine geç.
4. Kodu yapıştırıp Enter'a bas.
5. Token otomatik olarak panoya kopyalanır.
6. Kopyalanan değeri NexRPC içinde ilgili alana yapıştır.

> Bu yöntem güvenlik riski taşır. Tokeni asla paylaşma, log dosyalarına yazma veya GitHub gibi herkese açık alanlara koyma.

## Notlar

`discord.js-selfbot-v13` 3.7.1 artık arşivlenmiş/deprecated bir projedir. Discord tarafı değişirse ileride `src/main.js` içindeki bağlantı katmanının değiştirilmesi gerekebilir.

NexRPC'nin amacı Presence yönetimidir; mesaj okuma, mesaj gönderme, sunucu moderasyonu veya benzeri self-bot özellikleri bu build'e eklenmemiştir.
