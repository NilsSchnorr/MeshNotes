// js/export/share.js - Ephemeral sharing via Cloudflare R2
//
// Uploads model files + annotations to R2 and returns a share link.
// Share links expire after 90 days (enforced by R2 lifecycle rules).

import { state, dom } from '../state.js';
import { showStatus } from '../utils/helpers.js';
import { buildAnnotationBlob } from './export-json.js';
import { buildShareUrl, buildDirectUrl } from '../core/url-params.js';

const SHARE_API_URL = '/api/share';

/**
 * Opens the share dialog. Does NOT upload anything yet —
 * the user must click "Generate Link" to trigger the upload.
 */
export function shareModel() {
    if (!state.currentModel) {
        showStatus('No model loaded to share');
        return;
    }

    if (!state.loadedModelFiles || state.loadedModelFiles.length === 0) {
        showStatus('No model files available — reload the model and try again');
        return;
    }

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

        showStatus('Share link created');

    } catch (error) {
        console.error('Share failed:', error);
        progressSection.style.display = 'none';
        errorSection.style.display = 'block';
        errorMessage.textContent = error.message;
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
        // Fallback for older browsers
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

    if (!modelUrl) {
        showStatus('Please enter a model URL');
        return;
    }

    const url = buildDirectUrl(modelUrl, annotationsUrl || null);

    const choiceSection = document.getElementById('share-choice');
    const resultSection = document.getElementById('share-result');
    const shareLink = document.getElementById('share-link');
    const shareExpiry = document.getElementById('share-expiry');

    shareLink.value = url;
    shareExpiry.textContent = 'Permanent link — valid as long as the hosted files are available';

    choiceSection.style.display = 'none';
    resultSection.style.display = 'block';
}
