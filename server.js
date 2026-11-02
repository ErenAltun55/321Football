const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const oyuncular = require("./oyuncular");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("Public"));

// ---------- Veri hazırlığı ----------
function sadelestir(metin) {
  return metin
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

oyuncular.forEach((o) => {
  o.ad = sadelestir(o.isim);
  o.soyad = o.ad.split(" ").pop();
});

// Ortak futbolcusu olan takım çiftlerini bul
const takimlar = [...new Set(oyuncular.flatMap((o) => o.takimlar))];
const ciftler = [];
for (let i = 0; i < takimlar.length; i++) {
  for (let j = i + 1; j < takimlar.length; j++) {
    const a = takimlar[i];
    const b = takimlar[j];
    const ortakVar = oyuncular.some(
      (o) => o.takimlar.includes(a) && o.takimlar.includes(b)
    );
    if (ortakVar) ciftler.push([a, b]);
  }
}

function dogruMu(giris, t1, t2) {
  const g = sadelestir(giris);
  if (g.length < 3) return null;
  return (
    oyuncular.find(
      (o) =>
        (o.ad === g || o.soyad === g) &&
        o.takimlar.includes(t1) &&
        o.takimlar.includes(t2)
    ) || null
  );
}

// ---------- Oyun mantığı ----------
let bekleyen = null;
let odaSayac = 0;
const odalar = {};

function odaSil(odaId) {
  const oda = odalar[odaId];
  if (!oda) return;
  clearInterval(oda.zamanlayici);
  clearTimeout(oda.sureBitis);
  clearTimeout(oda.sonraki);
  delete odalar[odaId];
}

function skorGonder(oda) {
  const [a, b] = oda.oyuncular;
  a.emit("score", { sen: oda.skor[a.id], rakip: oda.skor[b.id] });
  b.emit("score", { sen: oda.skor[b.id], rakip: oda.skor[a.id] });
}

function turBaslat(odaId) {
  const oda = odalar[odaId];
  if (!oda) return;

  let sayi = 3;
  io.to(odaId).emit("countdown", sayi);

  oda.zamanlayici = setInterval(() => {
    sayi--;
    if (sayi > 0) {
      io.to(odaId).emit("countdown", sayi);
      return;
    }

    clearInterval(oda.zamanlayici);

    const cift = ciftler[Math.floor(Math.random() * ciftler.length)];
    oda.takimlar = Math.random() < 0.5 ? cift : [cift[1], cift[0]];
    oda.aktif = true;
    io.to(odaId).emit("roundStart", {
      takim1: oda.takimlar[0],
      takim2: oda.takimlar[1],
    });

    // 30 saniyede kimse bulamazsa tur biter
    oda.sureBitis = setTimeout(() => {
      if (!oda.aktif) return;
      oda.aktif = false;
      io.to(odaId).emit("roundTimeout");
      oda.sonraki = setTimeout(() => turBaslat(odaId), 3000);
    }, 30000);
  }, 1000);
}

io.on("connection", (socket) => {
  socket.on("findMatch", () => {
    if (bekleyen === socket || socket.odaId) return;

    if (bekleyen && bekleyen.connected) {
      const odaId = "oda" + ++odaSayac;
      const birinci = bekleyen;
      bekleyen = null;

      birinci.join(odaId);
      socket.join(odaId);
      birinci.odaId = odaId;
      socket.odaId = odaId;

      const oda = {
        oyuncular: [birinci, socket],
        skor: { [birinci.id]: 0, [socket.id]: 0 },
        aktif: false,
        takimlar: [],
      };
      odalar[odaId] = oda;

      io.to(odaId).emit("matchFound");
      skorGonder(oda);
      oda.sonraki = setTimeout(() => turBaslat(odaId), 1000);
    } else {
      bekleyen = socket;
      socket.emit("waiting");
    }
  });

  socket.on("guess", (giris) => {
    const oda = odalar[socket.odaId];
    if (!oda || !oda.aktif || typeof giris !== "string") return;

    const bulunan = dogruMu(giris, oda.takimlar[0], oda.takimlar[1]);
    if (!bulunan) {
      socket.emit("wrong");
      return;
    }

    // ilk doğru cevap turu bitirir
    oda.aktif = false;
    clearTimeout(oda.sureBitis);
    oda.skor[socket.id]++;
    skorGonder(oda);
    io.to(socket.odaId).emit("roundWon", {
      kazanan: socket.id,
      oyuncu: bulunan.isim,
    });

    if (oda.skor[socket.id] >= 3) {
      io.to(socket.odaId).emit("gameOver", { kazanan: socket.id });
    } else {
      const odaId = socket.odaId;
      oda.sonraki = setTimeout(() => turBaslat(odaId), 3000);
    }
  });

  socket.on("disconnect", () => {
    if (bekleyen === socket) bekleyen = null;
    if (socket.odaId) {
      socket.to(socket.odaId).emit("opponentLeft");
      odaSil(socket.odaId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Sunucu çalışıyor: http://localhost:" + PORT);
});
