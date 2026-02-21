// js/ui/tool-help.js - Unified tool info panel management
// All tool-specific info panels (tool-help, brush-display, measurement-display) are managed here
import { state, dom } from '../state.js';

// ============ Tool Help Content (compact format matching surface/measure style) ============

const toolHelpContent = {
    boxEdit: {
        icon: '🔓',
        name: 'Edit Box',
        content: `
            <div class="help-section">
                <div class="help-section-title">Manipulation</div>
                <div class="help-row"><span class="help-key">Drag box</span><span class="help-desc">Move</span></div>
                <div class="help-row"><span class="help-key">Drag corner</span><span class="help-desc">Resize</span></div>
                <div class="help-row"><span class="help-key">Right-drag</span><span class="help-desc">Rotate</span></div>
                <div class="help-row"><span class="help-key">Shift</span><span class="help-key">Right-drag</span><span class="help-desc">Snap 15°</span></div>
            </div>
            <div class="help-section">
                <div class="help-section-title" style="color: #EDC040;">Finish Editing</div>
                <div class="help-row"><span class="help-key" style="background: #EDC040; color: #1a1a2e;">Double-click</span><span class="help-desc">Lock box</span></div>
                <div class="help-row"><span class="help-key">Esc</span><span class="help-desc">Lock &amp; exit</span></div>
                <div class="help-row"><span class="help-key">Click elsewhere</span><span class="help-desc">Lock box</span></div>
            </div>
            <div class="help-section">
                <div class="help-section-title">Navigation</div>
                <div class="help-row"><span class="help-key">Left-drag</span><span class="help-desc">Rotate view</span></div>
                <div class="help-row"><span class="help-key">Scroll</span><span class="help-desc">Zoom</span></div>
            </div>
        `
    },
    point: {
        icon: '📍',
        name: 'Point Annotation',
        content: `
            <div class="help-section">
                <div class="help-section-title">Controls</div>
                <div class="help-row"><span class="help-key">Click</span><span class="help-desc">Place point</span></div>
                <div class="help-row"><span class="help-key">Esc</span><span class="help-desc">Cancel</span></div>
            </div>
            <div class="help-section">
                <div class="help-section-title">Navigation</div>
                <div class="help-row"><span class="help-key">Left-drag</span><span class="help-desc">Rotate</span></div>
                <div class="help-row"><span class="help-key">Right-drag</span><span class="help-desc">Pan</span></div>
                <div class="help-row"><span class="help-key">Scroll</span><span class="help-desc">Zoom</span></div>
            </div>
        `
    },
    line: {
        icon: '📏',
        name: 'Line Annotation',
        content: `
            <div class="help-section">
                <div class="help-section-title">Drawing</div>
                <div class="help-row"><span class="help-key">Click</span><span class="help-desc">Add point</span></div>
                <div class="help-row"><span class="help-key">Double-click</span><span class="help-desc">Finish</span></div>
                <div class="help-row"><span class="help-key">Ctrl</span><span class="help-key">Z</span><span class="help-desc">Undo</span></div>
                <div class="help-row"><span class="help-key">Esc</span><span class="help-desc">Cancel</span></div>
            </div>
            <div class="help-section">
                <div class="help-section-title">Navigation</div>
                <div class="help-row"><span class="help-key">Left-drag</span><span class="help-desc">Rotate</span></div>
                <div class="help-row"><span class="help-key">Right-drag</span><span class="help-desc">Pan</span></div>
                <div class="help-row"><span class="help-key">Scroll</span><span class="help-desc">Zoom</span></div>
            </div>
        `
    },
    polygon: {
        icon: '⬡',
        name: 'Polygon Annotation',
        content: `
            <div class="help-section">
                <div class="help-section-title">Drawing</div>
                <div class="help-row"><span class="help-key">Click</span><span class="help-desc">Add vertex</span></div>
                <div class="help-row"><span class="help-key">Double-click</span><span class="help-desc">Close</span></div>
                <div class="help-row"><span class="help-key">Ctrl</span><span class="help-key">Z</span><span class="help-desc">Undo</span></div>
                <div class="help-row"><span class="help-key">Esc</span><span class="help-desc">Cancel</span></div>
            </div>
            <div class="help-section">
                <div class="help-section-title">Navigation</div>
                <div class="help-row"><span class="help-key">Left-drag</span><span class="help-desc">Rotate</span></div>
                <div class="help-row"><span class="help-key">Right-drag</span><span class="help-desc">Pan</span></div>
                <div class="help-row"><span class="help-key">Scroll</span><span class="help-desc">Zoom</span></div>
            </div>
        `
    },
    box: {
        icon: '📦',
        name: 'Box Annotation',
        content: `
            <div class="help-section">
                <div class="help-section-title">1. Place &amp; Adjust</div>
                <div class="help-row"><span class="help-key">Click</span><span class="help-desc">Place box on model</span></div>
                <div class="help-row"><span class="help-key">Drag box</span><span class="help-desc">Move</span></div>
                <div class="help-row"><span class="help-key">Drag corner</span><span class="help-desc">Resize</span></div>
                <div class="help-row"><span class="help-key">Right-drag</span><span class="help-desc">Rotate</span></div>
                <div class="help-row"><span class="help-key">Shift</span><span class="help-key">Right-drag</span><span class="help-desc">Snap 15°</span></div>
            </div>
            <div class="help-section">
                <div class="help-section-title" style="color: #EDC040;">2. Confirm</div>
                <div class="help-row"><span class="help-key" style="background: #EDC040; color: #1a1a2e;">Double-click</span><span class="help-desc">Save box &amp; add details</span></div>
                <div class="help-row"><span class="help-key">Esc</span><span class="help-desc">Cancel</span></div>
            </div>
            <div class="help-section">
                <div class="help-section-title">Navigation</div>
                <div class="help-row"><span class="help-key">Left-drag</span><span class="help-desc">Rotate view</span></div>
                <div class="help-row"><span class="help-key">Scroll</span><span class="help-desc">Zoom</span></div>
            </div>
        `
    }
    // Note: surface and measure tools use their own dedicated panels (brush-display, measurement-display)
};

// ============ Hide All Tool Info Panels ============

/**
 * Hides all tool-specific info panels (tool-help, brush-display, measurement-display)
 */
export function hideAllToolPanels() {
    dom.toolHelp.classList.remove('visible');
    dom.brushDisplay.classList.remove('visible');
    dom.measurementDisplay.classList.remove('visible');
}

// ============ Tool Help Panel (point, line, polygon, box) ============

/**
 * Shows the tool help panel for the specified tool.
 * @param {string|null} tool - The tool name or null to hide
 */
export function showToolHelp(tool) {
    // First hide all panels
    hideAllToolPanels();
    
    // Handle special cases: surface and measure have their own panels
    if (tool === 'surface') {
        dom.brushDisplay.classList.add('visible');
        return;
    }
    
    if (tool === 'measure') {
        dom.measurementDisplay.classList.add('visible');
        return;
    }
    
    // Show tool-help panel for other tools
    if (!tool || !toolHelpContent[tool]) {
        return;
    }

    const help = toolHelpContent[tool];
    dom.toolHelpTitle.querySelector('.icon').textContent = help.icon;
    dom.toolHelpTitle.querySelector('.name').textContent = help.name;
    dom.toolHelpContent.innerHTML = help.content;
    dom.toolHelp.classList.add('visible');
}

/**
 * Hides the tool help panel.
 */
export function hideToolHelp() {
    dom.toolHelp.classList.remove('visible');
}

/**
 * Restores the appropriate tool panel if a tool is currently active.
 * Call this after closing popups to bring back the help.
 */
export function restoreToolHelp() {
    if (state.currentTool) {
        showToolHelp(state.currentTool);
    }
}

/**
 * Shows the box edit help panel when a box is unlocked for editing.
 */
export function showBoxEditHelp() {
    showToolHelp('boxEdit');
}

/**
 * Clears the box edit state (unlocks any locked box) and hides the edit help.
 * Call this when ESC is pressed, a tool is selected, or clicking elsewhere.
 * @param {boolean} [skipRender=false] - If true, skip calling renderAnnotations (for cases where it's called separately)
 */
export function clearBoxEditState(skipRender = false) {
    if (state.boxEditUnlocked !== null) {
        state.boxEditUnlocked = null;
        hideToolHelp();
        // Note: renderAnnotations is intentionally not called here to avoid circular dependencies.
        // The caller should handle re-rendering if visual feedback update is needed.
    }
}
