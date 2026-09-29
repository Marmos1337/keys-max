import { esc, icon, select } from './utils.js';
import { request } from './api.js';

const pending = new WeakMap();
export function coverFields(a = {}) {
    const stock = ['living','owner','room'].includes(a.photo) ? a.photo : 'living';
    const stockArt = stock === 'owner' ? 'house' : stock;
    const current = a.cover_url || '/art/' + stockArt + '.webp';
    const options = [...(a.id ? [['current', 'Оставить текущую обложку']] : []), ['living', 'Стандартная иллюстрация: гостиная'], ['room', 'Стандартная иллюстрация: комната'], ['owner', 'Стандартная иллюстрация: дом'], ['upload', 'Использовать загруженную фотографию']];
    return `<section class="cover-editor" data-cover-editor data-current-src="${esc(current)}" data-current-id="${esc(a.cover_id || '')}" data-stock="${esc(stock)}">
        <div class="cover-editor-title"><h3>Фото квартиры</h3><span>Обложка карточки</span></div>
        <img class="cover-preview" data-cover-preview src="${esc(current)}" alt="Предпросмотр обложки квартиры">
        <label class="cover-upload"><span class="btn secondary">${icon('camera',18)} Загрузить фото</span>
            <input name="cover_file" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Загрузить фото квартиры">
        </label>
        <p class="small-note">Здесь можно либо оставить стандартную иллюстрацию, либо загрузить свою фотографию. JPG, PNG или WebP, до 10 МБ. Изменения появятся после сохранения.</p>
        ${select('Источник обложки', 'cover_mode', options, a.id ? 'current' : 'living').replace('<option value="upload"', '<option value="upload" disabled')}
        <p class="cover-feedback small-note" data-cover-feedback role="status" aria-live="polite"></p>
    <p class="small-note">Можно выбрать одну из трёх стандартных обложек или загрузить свою фотографию квартиры.</p></section>`;
}
function resetPreviewUrl(editor) {
    if (editor.dataset.blob) URL.revokeObjectURL(editor.dataset.blob);
    delete editor.dataset.blob;
}
export function releaseCoverPreviews(root) {
    root?.querySelectorAll('[data-cover-editor]').forEach(resetPreviewUrl);
}
export async function handleCoverChange(el) {
    const editor = el.closest('[data-cover-editor]');
    if (!editor) return;
    const preview = editor.querySelector('[data-cover-preview]'), feedback = editor.querySelector('[data-cover-feedback]');
    const input = editor.querySelector('[name=cover_file]'), mode = editor.querySelector('[name=cover_mode]');
    if (el === input) {
        const file = input.files[0];
        if (!file) return;
        try { validateFile(file); }
        catch (e) { input.value = ''; resetPreviewUrl(editor); mode.value = editor.dataset.currentId ? 'current' : editor.dataset.stock; mode.querySelector('[value=upload]').disabled = true; preview.src = editor.dataset.currentSrc; feedback.textContent = e.message; throw e; }
        resetPreviewUrl(editor);
        const blob = URL.createObjectURL(file);
        editor.dataset.blob = blob;
        preview.src = blob;
        mode.querySelector('[value=upload]').disabled = false;
        mode.value = 'upload';
        feedback.textContent = file.name + ' · Фотография выбрана. Нажмите «Сохранить», чтобы применить её к карточке.';
    } else if (el === mode) {
        if (mode.value === 'upload') {
            if (input.files[0]) { preview.src = editor.dataset.blob; return; }
            mode.value = editor.dataset.currentId ? 'current' : editor.dataset.stock;
            feedback.textContent = 'Сначала выберите файл кнопкой «Загрузить фото».';
            return;
        }
        resetPreviewUrl(editor); input.value = ''; mode.querySelector('[value=upload]').disabled = true;
        const art = mode.value === 'owner' ? 'house' : mode.value;
        preview.src = mode.value === 'current' ? editor.dataset.currentSrc : '/art/' + art + '.webp';
        feedback.textContent = mode.value === 'current' ? 'Текущая обложка останется без изменений.' : 'После сохранения на карточке будет показана выбранная стандартная иллюстрация.';
    }
}
function validateFile(file) {
    if (!file || !file.size) throw Error('Выберите непустую фотографию.');
    if (file.size > 10 * 1024 * 1024) throw Error('Фото больше 10 МБ. Выберите файл поменьше.');
    if (!/\.(jpe?g|png|webp)$/i.test(file.name) || (file.type && !['image/jpeg','image/png','image/webp'].includes(file.type)))
        throw Error('Нужна фотография JPG, PNG или WebP. Для HEIC сначала сохраните копию в JPG.');
}
async function decodedImage(file) {
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        const ready = new Promise((resolve,reject) => { image.onload = resolve; image.onerror = () => reject(Error('Не удалось открыть фото. Выберите другой файл JPG, PNG или WebP.')); });
        image.src = url; await ready; return image;
    } finally { URL.revokeObjectURL(url); }
}
async function preparePhoto(file) {
    validateFile(file);
    const image = await decodedImage(file);
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width * height > 40_000_000) throw Error('Слишком большое разрешение: максимум 40 мегапикселей.');
    const scale = Math.min(1, 1920 / Math.max(width,height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width*scale); canvas.height = Math.round(height*scale);
    const context = canvas.getContext('2d');
    if (!context) throw Error('Не удалось подготовить фото. Попробуйте другой браузер.');
    context.fillStyle = '#f4f5f6'; context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    // Re-encode for a compact cover and omit original EXIF/GPS metadata.
    const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.9));
    if (!blob) throw Error('Не удалось сохранить изображение. Выберите другую фотографию.');
    return blob;
}
export async function collectCover(form) {
    const editor = form.querySelector('[data-cover-editor]');
    if (!editor) return {};
    const mode = editor.querySelector('[name=cover_mode]').value;
    if (mode === 'current') return { photo: editor.dataset.stock, cover_id: editor.dataset.currentId || null };
    if (['living','owner','room'].includes(mode)) return { photo: mode, cover_id: null };
    const input = editor.querySelector('[name=cover_file]'), file = input.files[0];
    validateFile(file);
    const prior = pending.get(input);
    if (prior?.file === file) return { photo: editor.dataset.stock, cover_id: prior.id };
    const feedback = editor.querySelector('[data-cover-feedback]');
    feedback.textContent = 'Подготавливаем и загружаем фото…';
    const body = await preparePhoto(file);
    const cleanName = (file.name.replace(/\.[^.]+$/, '').slice(0,100) || 'apartment') + '.jpg';
    const result = await request('/apartment-covers?name=' + encodeURIComponent(cleanName), { method: 'POST', body, raw: true });
    pending.set(input, { file, id: result.id });
    feedback.textContent = 'Фото загружено. Сохраняем карточку…';
    return { photo: editor.dataset.stock, cover_id: result.id };
}
