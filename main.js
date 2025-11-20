(async () => {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const path = require("path");
  const Store = require("electron-store");
  const store = new Store();
  const { Client, RichPresence } = require("discord.js-selfbot-v13");

  // Genel hata yakalama
  process.on("uncaughtException", (error) => {
    console.error("Yakalanan Hata:", error);
    // Hata dosyasına kaydet
    const fs = require("fs");
    const logPath = path.join(app.getPath("userData"), "error.log");
    fs.appendFileSync(logPath, `${new Date().toISOString()} - ${error}\n`);
  });

  // Electron hata yakalama
  app.on("render-process-gone", (event, webContents, details) => {
    console.error("Render Process Hatası:", details);
  });

  app.on("child-process-gone", (event, details) => {
    console.error("Child Process Hatası:", details);
  });

  let mainWindow;
  let discordClient;

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
      icon: path.join(__dirname, "assets", "discord.ico"),
      ...(process.platform === "win32"
        ? {
            icon: path.join(__dirname, "assets", "discord.ico"),
          }
        : {}),
    });

    // HTML dosyasını yükle
    mainWindow.loadFile("index.html").catch((err) => {
      console.error("LoadFile ile yükleme hatası:", err);
    });

    // Menu bar'ı gizle
    mainWindow.setMenuBarVisibility(false);

    // Varsayılan menüyü kaldır
    mainWindow.removeMenu();

    // F12 ve Ctrl+Shift+I kısayollarını devre dışı bırak
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (
        input.key === "F12" ||
        (input.control && input.shift && input.key.toLowerCase() === "i")
      ) {
        event.preventDefault();
      }
    });

    // Sağ tık menüsünü devre dışı bırak
    mainWindow.webContents.on("context-menu", (event) => {
      event.preventDefault();
    });

    // Yükleme durumunu izle
    mainWindow.webContents.on("did-finish-load", () => {
      console.log("Sayfa yüklendi");
    });

    mainWindow.webContents.on(
      "did-fail-load",
      (event, errorCode, errorDescription) => {
        console.error("Sayfa yükleme hatası:", errorCode, errorDescription);
      }
    );

    // Pencere hazır olduğunda
    mainWindow.once("ready-to-show", () => {
      console.log("Pencere gösterime hazır");
      mainWindow.focus();
    });

    mainWindow.webContents.on("crashed", (event) => {
      console.error("Window crashed:", event);
    });
    
    // Pencereyi hemen göster
    mainWindow.show();
  }

  app.whenReady().then(async () => {
    console.log("Uygulama hazır");
    createWindow();

    const lastToken = store.get("lastUsedToken");
    if (lastToken) {
      try {
        discordClient = new Client();
        await discordClient.login(lastToken);

        // Kullanıcı bilgilerini al
        const user = discordClient.user;
        const userInfo = {
          username: user.username,
          discriminator: user.discriminator,
          id: user.id,
          avatar: user.displayAvatarURL({ dynamic: true, size: 128 }),
          banner: user.bannerURL({ dynamic: true, size: 600 }) || null,
          status: user.presence?.status || "online",
          createdAt: user.createdAt,
        };

        const accounts = store.get("accounts") || {};
        const savedSettings = accounts[lastToken].gameSettings;

        mainWindow.webContents.send("auto-login", {
          success: true,
          token: lastToken,
          userInfo,
          savedSettings,
        });
      } catch (error) {
        console.error("Otomatik giriş hatası:", error);
        store.delete("lastUsedToken");
      }
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  ipcMain.on("set-token", async (event, token) => {
    try {
      const newClient = new Client();
      await newClient.login(token);

      if (discordClient) {
        await discordClient.destroy();
      }

      discordClient = newClient;
      store.set("lastUsedToken", token);

      // Kullanıcı bilgilerini al
      const user = discordClient.user;
      const userInfo = {
        username: user.username,
        discriminator: user.discriminator,
        id: user.id,
        avatar: user.displayAvatarURL({ dynamic: true, size: 128 }),
        banner: user.bannerURL({ dynamic: true, size: 600 }) || null,
        status: user.presence?.status || "online",
        createdAt: user.createdAt,
      };

      // Hesap ayarlarını al
      const accounts = store.get("accounts") || {};
      if (!accounts[token]) {
        accounts[token] = { gameSettings: null };
        store.set("accounts", accounts);
      }

      const savedSettings = accounts[token].gameSettings;
      event.reply("login-status", {
        success: true,
        userInfo,
        savedSettings,
      });
    } catch (error) {
      console.error("Login Hatası:", error);
      event.reply("login-status", { success: false, error: error.message });
    }
  });

  ipcMain.on("save-settings", async (event, gameData) => {
    const currentToken = store.get("lastUsedToken");
    if (!currentToken) {
      event.reply("save-status", {
        success: false,
        error: "Aktif hesap bulunamadı",
      });
      return;
    }

    const accounts = store.get("accounts") || {};
    accounts[currentToken].gameSettings = gameData;
    store.set("accounts", accounts);

    event.reply("save-status", { success: true });
  });

  ipcMain.on("logout", async (event) => {
    if (discordClient) {
      await discordClient.destroy();
      discordClient = null;
    }
    store.delete("lastUsedToken");
    event.reply("logout-status", { success: true });
  });

  ipcMain.on("set-game", async (event, gameData) => {
    if (!discordClient) {
      console.error("Discord client bağlantısı yok!");
      event.reply("game-status", {
        success: false,
        error: "Discord bağlantısı yok",
      });
      return;
    }

    try {
      console.log("Gelen aktivite verisi:", gameData);

      // RichPresence oluştur
      const presence = new RichPresence(discordClient)
        .setApplicationId("1310982134344847391")
        .setName(gameData.name)
        .setType(gameData.type)
        .setPlatform("desktop");

      // Detayları ayarla
      if (gameData.details) presence.setDetails(gameData.details);
      if (gameData.state) presence.setState(gameData.state);

      // Resimleri ayarla
      if (gameData.assets?.large_image) {
        presence.setAssetsLargeImage(gameData.assets.large_image);
      }
      if (gameData.assets?.large_text) {
        presence.setAssetsLargeText(gameData.assets.large_text);
      }
      if (gameData.assets?.small_image) {
        presence.setAssetsSmallImage(gameData.assets.small_image);
      }
      if (gameData.assets?.small_text) {
        presence.setAssetsSmallText(gameData.assets.small_text);
      }

      // Butonları ekle
      if (gameData.buttons && gameData.buttons.length > 0) {
        console.log("Butonlar:", gameData.buttons);
        gameData.buttons.forEach((button) => {
          console.log("Buton ekleniyor:", button);
          presence.addButton(button.name || button.label, button.url);
        });
      }

      console.log("RPC verisi:", presence);

      try {
        await discordClient.user.setActivity(presence);
        console.log("Aktivite başarıyla ayarlandı");
        event.reply("game-status", { success: true });
      } catch (error) {
        console.error("Discord API Hatası:", error);
        event.reply("game-status", { success: false, error: error.message });
      }
    } catch (error) {
      console.error("Genel Hata:", error);
      event.reply("game-status", { success: false, error: error.message });
    }
  });

  /*
  app.on("browser-window-created", (event, window) => {
    window.webContents.on("before-input-event", (event, input) => {
      if (
        input.key === "F12" ||
        (input.control && input.shift && input.key.toLowerCase() === "i")
      ) {
        event.preventDefault();
      }
    });
  });
  */
})();
