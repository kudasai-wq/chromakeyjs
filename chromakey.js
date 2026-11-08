/**
 * ChromaKey.js
 * Библиотека для удаления фона (хромакея) на основе цветового пространства YCbCr.
 * 
 * Математическая модель: 
 * 1. Перевод пикселей в YCbCr (Яркость + Цветность) для отделения теней от цвета.
 * 2. Вычисление евклидова расстояния по цветности (Cb, Cr) для создания маски прозрачности.
 * 3. Техника Despill (удаление цветового оттенка) для устранения ореолов на объекте.
 * 4. Трехпроходный Box Blur для сглаживания (диффузии) альфа-канала.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory); // AMD
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(); // CommonJS (Node.js)
  } else {
    root.ChromaKey = factory(); // Браузер (window.ChromaKey)
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Определяет доминирующий цвет фона.
   * Берет выборку из 8 пикселей по краям изображения, группирует их 
   * по цветовым корзинам (с шагом 16) и возвращает самый частый цвет.
   * 
   * @param {ImageData} imageData - Объект ImageData (содержит width, height, data).
   * @returns {{r: number, g: number, b: number}} Цвет фона в формате RGB.
   */
  function detectBgColor(imageData) {
    const d = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    
    const points = [
      [10, 10], [w - 10, 10], [10, h - 10], [w - 10, h - 10],
      [w / 2, 10], [w / 2, h - 10], [10, h / 2], [w - 10, h / 2]
    ];
    
    const counts = new Map();
    for (const [x, y] of points) {
      const i = (Math.floor(y) * w + Math.floor(x)) * 4;
      if (d[i + 3] < 128) continue; // Пропускаем уже прозрачные пиксели
      
      // Группируем цвета, отбрасывая младшие 4 бита (точность 16 оттенков)
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    
    let best = 0, bestN = -1;
    for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k; }
    
    return {
      r: ((best >> 8) & 15) * 17,
      g: ((best >> 4) & 15) * 17,
      b: (best & 15) * 17
    };
  }

  /**
   * Применяет эффект хромакея к данным изображения.
   * Изменяет альфа-канал (прозрачность) и корректирует цвета (Despill, тени).
   * 
   * @param {ImageData} imageData - Исходные данные пикселей (НЕ изменяются).
   * @param {{r: number, g: number, b: number}} bg - Цвет фона для удаления.
   * @param {Object} [params={}] - Настройки обработки.
   * @param {number} [params.tol=60] - Допуск (0-100). 100 = удалить всё, 0 = только идеальный фон.
   * @param {number} [params.despill=100] - Сила удаления оттенка (0-100).
   * @param {number} [params.shadow=50] - Плотность теней (0-100).
   * @param {number} [params.diffusion=20] - Размытие краев (0-100).
   * @returns {ImageData} Новый объект ImageData с прозрачным фоном.
   */
  function process(imageData, bg, params = {}) {
    const w = imageData.width;
    const h = imageData.height;
    
    // Клонируем данные, чтобы не мутировать оригинал (Immutable подход)
    const out = new ImageData(new Uint8ClampedArray(imageData.data), w, h);
    const d = out.data;

    // Нормализация входных параметров
    const p = {
      tol: params.tol !== undefined ? params.tol : 60,
      desStr: params.despill !== undefined ? params.despill / 100 : 1.0,
      shadowStr: params.shadow !== undefined ? params.shadow / 100 : 0.5,
      diffusion: params.diffusion !== undefined ? params.diffusion / 100 : 0.2
    };

    // Вычисление YCbCr для фона (базовые значения)
    const bgY = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;
    const bgCb = bg.b - bgY;
    const bgCr = bg.r - bgY;

    const limit = (100 - p.tol) * 1.5; 
    const softness = 15; // Мягкость перехода (в единицах цветности)
    
    const isGreen = bg.g > bg.r && bg.g > bg.b;
    const isBlue  = bg.b > bg.r && bg.b > bg.g;

    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      
      // 1. Перевод текущего пикселя в YCbCr
      let Y = 0.299 * r + 0.587 * g + 0.114 * b;
      let Cb = b - Y;
      let Cr = r - Y;

      // 2. Вычисление евклидова расстояния по цветовым координатам
      let dCb = Cb - bgCb;
      let dCr = Cr - bgCr;
      let dist = Math.sqrt(dCb * dCb + dCr * dCr);

      // 3. Генерация альфа-канала (маски прозрачности)
      let alpha = 255;
      if (dist < limit) {
        alpha = 0; // Полностью прозрачный
      } else if (dist < limit + softness) {
        alpha = 255 * ((dist - limit) / softness); // Градиент на краях
      }

      // 4. Сохранение теней
      // Если пиксель имеет цвет фона, но его яркость (Y) ниже яркости фона
      if (p.shadowStr > 0 && dist < limit * 1.5 && Y < bgY) {
        let shadowAlpha = (Y / bgY) * p.shadowStr;
        if (shadowAlpha > (1 - alpha / 255)) {
          alpha = 255 * (1 - shadowAlpha);
          r = g = b = Y; // Перекрашиваем в нейтральный серый
        }
      }

      // 5. Despill (Подавление оттенка)
      // Сдвигаем доминирующий канал к среднему арифметическому двух других
      if (p.desStr > 0) {
        let keyVal, c1, c2;
        if (isGreen) { keyVal = g; c1 = r; c2 = b; }
        else if (isBlue) { keyVal = b; c1 = r; c2 = g; }
        else { keyVal = r; c1 = g; c2 = b; }

        let avgOther = (c1 + c2) / 2;
        if (keyVal > avgOther) {
          let newKey = keyVal - (keyVal - avgOther) * p.desStr;
          if (isGreen) g = newKey;
          else if (isBlue) b = newKey;
          else r = newKey;
        }
      }

      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = alpha;
    }

    // 6. Диффузия (Box Blur для альфа-канала)
    if (p.diffusion > 0) {
      const radius = Math.floor(p.diffusion * 99) + 1;
      applyFastBlur(d, w, h, radius);
    }

    return out;
  }

  /**
   * Внутренняя функция для размытия альфа-канала.
   * Реализует трехпроходный Box Blur (аппроксимация Гауссова размытия).
   * Работает только с альфа-каналом (d[i * 4 + 3]), не затрагивая RGB.
   * 
   * @param {Uint8ClampedArray} d - Массив данных пикселей.
   * @param {number} w - Ширина изображения.
   * @param {number} h - Высота изображения.
   * @param {number} radius - Радиус размытия в пикселях.
   */
  function applyFastBlur(d, w, h, radius) {
    const size = w * h;
    const a = new Uint8Array(size);
    const temp = new Uint8Array(size);

    // Извлекаем альфа-канал в отдельный массив для скорости
    for (let i = 0; i < size; i++) a[i] = d[i * 4 + 3];

    for (let pass = 0; pass < 3; pass++) {
      // Горизонтальный проход
      for (let y = 0; y < h; y++) {
        let sum = 0;
        let rowOffset = y * w;
        for (let x = -radius; x <= radius; x++) {
          if (x >= 0 && x < w) sum += a[rowOffset + x];
        }
        for (let x = 0; x < w; x++) {
          temp[rowOffset + x] = sum / (radius * 2 + 1);
          let addX = x + radius + 1;
          let subX = x - radius;
          if (addX < w) sum += a[rowOffset + addX];
          if (subX >= 0) sum -= a[rowOffset + subX];
        }
      }

      // Вертикальный проход
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = -radius; y <= radius; y++) {
          if (y >= 0 && y < h) sum += temp[y * w + x];
        }
        for (let y = 0; y < h; y++) {
          a[y * w + x] = sum / (radius * 2 + 1);
          let addY = y + radius + 1;
          let subY = y - radius;
          if (addY < h) sum += temp[addY * w + x];
          if (subY >= 0) sum -= temp[subY * w + x];
        }
      }
    }

    // Возвращаем размытый альфа-канал обратно
    for (let i = 0; i < size; i++) d[i * 4 + 3] = a[i];
  }

  // Экспорт публичного API
  return { detectBgColor, process };
}));