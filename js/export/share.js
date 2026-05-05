// js/export/share.js - Ephemeral sharing via Cloudflare R2
//
// Uploads model files + annotations to R2 and returns a share link.
// Share links expire after 90 days (enforced by R2 lifecycle rules).

import { state, dom } from '../state.js';
import { showStatus, escapeHtml } from '../utils/helpers.js';
import { buildAnnotationBlob } from './export-json.js';
import { buildShareUrl, buildDirectUrl } from '../core/url-params.js';

const SHARE_API_URL = '/api/share';
const HISTORY_STORAGE_KEY = 'meshnotes_shareHistory';

// ============ Share History (localStorage) ============

/**
 * Load share history from localStorage.
 * @returns {Array} Array of {url, modelName, createdAt, expiresAt, type}
 */
function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

/**
 * Save share history to localStorage.
 */
function saveHistory(history) {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
}

/**
 * Add a new entry to share history.
 */
function addToHistory(entry) {
    const history = loadHistory();
    // Add newest first
    history.unshift(entry);
    // Keep max 50 entries
    if (history.length > 50) history.length = 50;
    saveHistory(history);
}

/**
 * Remove a history entry by index.
 */
export function removeHistoryEntry(index) {
    const history = loadHistory();
    history.splice(index, 1);
    saveHistory(history);
    renderHistory();
}

/**
 * Render the share history list into the dialog.
 */
export function renderHistory() {
    const container = document.getElementById('share-history-list');
    if (!container) return;

    const history = loadHistory();

    if (history.length === 0) {
        container.innerHTML = '<p class="share-history-empty">No previously generated links.</p>';
        return;
    }

    const now = new Date();

    container.innerHTML = history.map((entry, index) => {
        const expiresAt = entry.expiresAt ? new Date(entry.expiresAt) : null;
        const isExpired = expiresAt && expiresAt < now;
        const isPermanent = entry.type === 'permanent';

        let statusText;
        let statusClass;
        if (isPermanent) {
            statusText = 'Permanent';
            statusClass = 'permanent';
        } else if (isExpired) {
            statusText = 'Expired';
            statusClass = 'expired';
        } else if (expiresAt) {
            const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
            statusText = `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`;
            statusClass = daysLeft <= 7 ? 'expiring-soon' : 'active';
        } else {
            statusText = 'Unknown';
            statusClass = 'unknown';
        }

        const createdDate = new Date(entry.createdAt).toLocaleDateString();
        const createdTime = new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `
            <div class="share-history-item ${isExpired ? 'expired' : ''}">
                <div class="share-history-info">
                    <span class="share-history-model">${escapeHtml(entry.modelName || 'Unknown model')}</span>
                    <span class="share-history-date">${createdDate} · ${createdTime}</span>
                    <span class="share-history-status ${statusClass}">${statusText}</span>
                </div>
                <div class="share-history-actions">
                    <button class="share-history-copy" data-url="${escapeHtml(entry.url)}" title="Copy link">📋</button>
                    <button class="share-history-delete" data-index="${index}" title="Remove from list">✕</button>
                </div>
            </div>
        `;
    }).join('');

    // Attach event listeners via delegation
    container.addEventListener('click', handleHistoryClick);
}

/**
 * Handle clicks inside the history list (delegation).
 */
function handleHistoryClick(e) {
    const copyBtn = e.target.closest('.share-history-copy');
    if (copyBtn) {
        const url = copyBtn.dataset.url;
        navigator.clipboard.writeText(url).then(() => {
            showStatus('Link copied to clipboard');
        }).catch(() => {
            // Fallback
            const temp = document.createElement('input');
            temp.value = url;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            document.body.removeChild(temp);
            showStatus('Link copied to clipboard');
        });
        return;
    }

    const deleteBtn = e.target.closest('.share-history-delete');
    if (deleteBtn) {
        const index = parseInt(deleteBtn.dataset.index);
        removeHistoryEntry(index);
        return;
    }
}

/**
 * Toggle the history section visibility.
 */
export function toggleHistory() {
    const section = document.getElementById('share-history');
    const toggle = document.getElementById('share-history-toggle');
    if (!section || !toggle) return;

    const isVisible = section.classList.toggle('visible');
    toggle.classList.toggle('expanded', isVisible);

    if (isVisible) {
        renderHistory();
    }
}

// ============ Share Dialog ============

/**
 * Opens the share dialog. Does NOT upload anything yet —
 * the user must click "Generate Link" to trigger the upload.
 * Always opens, even without a model loaded, so users can access link history.
 */
export function shareModel() {
    const dialog = document.getElementById('share-overlay');
    const choiceSection = document.getElementById('share-choice');
    const progressSection = document.getElementById('share-progress');
    const resultSection = document.getElementById('share-result');
    const errorSection = document.getElementById('share-error');

    // Reset to choice state
    choiceSection.style.display = 'block';
    progressSection.style.display = 'none';
    resultSection.style.display = 'none';
    errorSection.style.display = 'none';

    // Reset to ephemeral mode
    document.getElementById('share-mode-ephemeral').classList.add('active');
    document.getElementById('share-mode-longterm').classList.remove('active');
    document.getElementById('share-ephemeral-section').style.display = 'block';
    document.getElementById('share-longterm').style.display = 'none';

    // Collapse history
    const historySection = document.getElementById('share-history');
    const historyToggle = document.getElementById('share-history-toggle');
    if (historySection) historySection.classList.remove('visible');
    if (historyToggle) historyToggle.classList.remove('expanded');

    dialog.classList.add('visible');
}

/**
 * Uploads model + annotations to R2 and shows the share link.
 * Called when the user clicks "Generate Link" in the ephemeral share section.
 */
export async function generateEphemeralLink() {
    const choiceSection = document.getElementById('share-choice');
    const progressSection = document.getElementById('share-progress');
    const resultSection = document.getElementById('share-result');
    const errorSection = document.getElementById('share-error');
    const progressText = document.getElementById('share-progress-text');
    const shareLink = document.getElementById('share-link');
    const shareExpiry = document.getElementById('share-expiry');
    const errorMessage = document.getElementById('share-error-message');

    // Switch to progress state
    choiceSection.style.display = 'none';
    progressSection.style.display = 'block';
    resultSection.style.display = 'none';
    errorSection.style.display = 'none';

    try {
        // Pre-check total file size
        const totalBytes = state.loadedModelFiles.reduce((sum, f) => sum + f.size, 0);
        const totalMB = totalBytes / (1024 * 1024);
        if (totalMB > 100) {
            progressSection.style.display = 'none';
            choiceSection.style.display = 'none';
            errorSection.style.display = 'block';
            errorMessage.textContent = `Your model files total ${totalMB.toFixed(1)} MB, which exceeds the 100 MB upload limit. Try reducing the file size with Draco compression (e.g., optimizeglb.com or gltf-transform) or decimation in your 3D software before sharing.`;
            return;
        }

        // Build FormData with all files
        const formData = new FormData();

        // Add model files
        progressText.textContent = 'Preparing model files...';
        for (const file of state.loadedModelFiles) {
            formData.append('model', file, file.name);
        }

        // Add annotations JSON-LD (if there are annotations)
        if (state.annotations.length > 0) {
            progressText.textContent = 'Preparing annotations...';
            const annotationBlob = buildAnnotationBlob();
            const annotationFilename = `${state.modelFileName || 'annotations'}.jsonld`;
            formData.append('annotations', annotationBlob, annotationFilename);
        }

        // Upload to R2
        progressText.textContent = 'Uploading to meshnotes.org...';
        const response = await fetch(SHARE_API_URL, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `Upload failed (${response.status})`);
        }

        const result = await response.json();

        // Show result
        const url = buildShareUrl(result.shareId);
        shareLink.value = url;
        shareExpiry.textContent = `This link expires on ${new Date(result.expiresAt).toLocaleDateString()}`;

        progressSection.style.display = 'none';
        resultSection.style.display = 'block';

        // Save to history
        addToHistory({
            url,
            modelName: state.modelFileName || 'Unknown model',
            createdAt: new Date().toISOString(),
            expiresAt: result.expiresAt,
            type: 'ephemeral'
        });

        showStatus('Share link created');

    } catch (error) {
        console.error('Share failed:', error);
        progressSection.style.display = 'none';
        errorSection.style.display = 'block';

        // Detect file-too-large errors
        // Cloudflare returns 403 for bodies over 100MB at the platform level,
        // or may drop the connection entirely resulting in "Failed to fetch"
        const msg = error.message || '';
        if (msg.includes('413') || msg.includes('403') || msg.includes('Failed to fetch')) {
            // Calculate total size for the error message
            let totalMB = 0;
            if (state.loadedModelFiles) {
                totalMB = state.loadedModelFiles.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
            }
            errorMessage.textContent = `Upload failed — your files are ${totalMB.toFixed(1)} MB, which likely exceeds the 100 MB upload limit. Try reducing the file size with Draco compression (e.g., optimizeglb.com or gltf-transform) or decimation in your 3D software before sharing.`;
        } else {
            errorMessage.textContent = error.message;
        }
    }
}

/**
 * Copy the share link to clipboard.
 */
export function copyShareLink() {
    const shareLink = document.getElementById('share-link');
    if (!shareLink) return;

    shareLink.select();
    navigator.clipboard.writeText(shareLink.value).then(() => {
        showStatus('Link copied to clipboard');
    }).catch(() => {
        document.execCommand('copy');
        showStatus('Link copied to clipboard');
    });
}

/**
 * Close the share dialog.
 */
export function closeShareDialog() {
    const dialog = document.getElementById('share-overlay');
    if (dialog) dialog.classList.remove('visible');
}

/**
 * Switch to the long-term sharing section within the dialog.
 */
export function showLongTermShareDialog() {
    document.getElementById('share-ephemeral-section').style.display = 'none';
    document.getElementById('share-longterm').style.display = 'block';
}

/**
 * Switch to the ephemeral sharing section within the dialog.
 */
export function showEphemeralShareDialog() {
    document.getElementById('share-ephemeral-section').style.display = 'block';
    document.getElementById('share-longterm').style.display = 'none';
}

/**
 * Generate a long-term share link from user-provided URLs.
 */
export function generateLongTermLink() {
    const modelUrl = document.getElementById('longterm-model-url').value.trim();
    const annotationsUrl = document.getElementById('longterm-annotations-url').value.trim();
    const modelFormat = document.getElementById('longterm-model-format').value;

    if (!modelUrl) {
        showStatus('Please enter a model URL');
        return;
    }

    const url = buildDirectUrl(modelUrl, annotationsUrl || null, modelFormat);

    const choiceSection = document.getElementById('share-choice');
    const resultSection = document.getElementById('share-result');
    const shareLink = document.getElementById('share-link');
    const shareExpiry = document.getElementById('share-expiry');

    shareLink.value = url;
    shareExpiry.textContent = 'Permanent link — valid as long as the hosted files are available';

    choiceSection.style.display = 'none';
    resultSection.style.display = 'block';

    // Save to history
    addToHistory({
        url,
        modelName: state.modelFileName || 'Direct link',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        type: 'permanent'
    });
}
