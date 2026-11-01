import * as THREE from 'three';

// UV は Blender 側で「1 単位 = 1m」の箱投影にしてあるので、repeat = 1 / (テクスチャ 1 枚の実寸 m)

function canvasTexture(size, draw, metersX, metersY = metersX, srgb = true) {
  const c = document.createElement('canvas');
  c.width = size[0];
  c.height = size[1];
  draw(c.getContext('2d'), c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / metersX, 1 / metersY);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noise(g, w, h, amount, alpha = 0.06) {
  for (let i = 0; i < amount; i++) {
    const v = Math.random() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * Math.random()})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

// 500mm 角タイルカーペット。目地方向を市松に変えて陰影差を出す (1 枚 = 1m 四方 = 2x2 タイル)
export function carpet() {
  return canvasTexture([512, 512], (g, w, h) => {
    const tones = ['#59626e', '#626b77'];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        g.fillStyle = tones[(i + j) % 2];
        g.fillRect(i * 256, j * 256, 256, 256);
        g.strokeStyle = 'rgba(0,0,0,0.05)';
        for (let k = 0; k < 256; k += 4) {
          g.beginPath();
          if ((i + j) % 2) { g.moveTo(i * 256 + k, j * 256); g.lineTo(i * 256 + k, j * 256 + 256); }
          else { g.moveTo(i * 256, j * 256 + k); g.lineTo(i * 256 + 256, j * 256 + k); }
          g.stroke();
        }
      }
    }
    noise(g, w, h, 30000, 0.12);
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 1.5;
    for (let k = 0; k <= 512; k += 256) {
      g.beginPath(); g.moveTo(k, 0); g.lineTo(k, h); g.stroke();
      g.beginPath(); g.moveTo(0, k); g.lineTo(w, k); g.stroke();
    }
  }, 1);
}

// システム天井 600mm グリッド + 吸音板の点模様
export function ceiling() {
  return canvasTexture([256, 256], (g, w, h) => {
    g.fillStyle = '#f1f1ee';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.07})`;
      g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
    g.fillStyle = '#d5d6d6';
    g.fillRect(0, 0, w, 3);
    g.fillRect(0, 0, 3, h);
  }, 0.6);
}

export function wall() {
  return canvasTexture([256, 256], (g, w, h) => {
    g.fillStyle = '#e9e7e1';
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 6000, 0.05);
  }, 1);
}

// 向かいのビル: 1 枚 = 幅 3m x 1 フロア 3.5m
export function facade() {
  return canvasTexture([128, 150], (g, w, h) => {
    g.fillStyle = '#a7acb1';
    g.fillRect(0, 0, w, h);
    const grd = g.createLinearGradient(0, 30, 0, 120);
    grd.addColorStop(0, '#5e7890');
    grd.addColorStop(1, '#3d5265');
    g.fillStyle = grd;
    g.fillRect(10, 30, w - 20, 88);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    g.fillRect(10, 30, w - 20, 10);
    g.fillStyle = '#8d9297';
    g.fillRect(w / 2 - 2, 30, 4, 88);
  }, 3, 3.5);
}

// モニター画面 (表計算っぽい画面をタイル)
export function screen() {
  return canvasTexture([256, 160], (g, w, h) => {
    g.fillStyle = '#f4f6f8';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1f6f43';
    g.fillRect(0, 0, w, 14);
    g.strokeStyle = '#c9ced3';
    for (let x = 0; x < w; x += 32) { g.beginPath(); g.moveTo(x, 14); g.lineTo(x, h); g.stroke(); }
    for (let y = 14; y < h; y += 10) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.fillStyle = '#555';
    for (let y = 17; y < h; y += 10) {
      for (let x = 3; x < w; x += 32) if (Math.random() < 0.7) g.fillRect(x, y, 6 + Math.random() * 20, 4);
    }
  }, 0.5, 0.3);
}
