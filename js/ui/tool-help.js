// js/ui/tool-help.js - Unified tool info panel management
// All tool-specific info panels (tool-help, brush-display, measurement-display) are managed here
import { state, dom } from '../state.js';

// ============ Tool Help Content (compact format matching surface/measure style) ============

const toolHelpContent = {
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
                <div class="help-section-title">Controls</div>
                <div class="help-row"><span class="help-key">Click</span><span class="help-desc">Place box</span></div>
                <div class="help-row"><span class="help-key">Drag box</span><span class="help-desc">Move</span></div>
                <div class="help-row"><span class="help-key">Drag corner</span><span class="help-desc">Resize</span></div>
                <div class="help-row"><span class="help-key">Right-drag</span><span class="help-desc">Rotate</span></div>
                <div class="help-row"><span class="help-key">Shift</span><span class="help-key">Right-drag</span><span class="help-desc">Snap 15°</span></div>
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
