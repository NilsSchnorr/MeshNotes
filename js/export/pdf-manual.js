// js/export/pdf-manual.js

export function downloadManualAsPdf() {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 20;
    const contentWidth = pageWidth - (margin * 2);
    const lineHeight = 6;
    const headerLineHeight = 8;

    let yPos = margin;

    // ===== TITLE PAGE =====
    pdf.setFontSize(28);
    pdf.setTextColor(170, 129, 1);
    pdf.text('MeshNotes', pageWidth / 2, 50, { align: 'center' });

    pdf.setFontSize(20);
    pdf.setTextColor(60, 60, 60);
    pdf.text('User Manual', pageWidth / 2, 65, { align: 'center' });

    pdf.setFontSize(11);
    pdf.setTextColor(120, 120, 120);
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    pdf.text(`Generated: ${dateStr}`, pageWidth / 2, 80, { align: 'center' });

    pdf.setFontSize(11);
    pdf.setTextColor(80, 80, 80);
    const subtitle = 'A browser-based tool for annotating 3D models with points, lines, polygons, and surfaces, designed for cultural heritage documentation.';
    const subtitleLines = pdf.splitTextToSize(subtitle, contentWidth - 20);
    pdf.text(subtitleLines, pageWidth / 2, 100, { align: 'center' });

    pdf.setFontSize(10);
    pdf.setTextColor(170, 129, 1);
    pdf.textWithLink('github.com/NilsSchnorr/MeshNotes', pageWidth / 2, 130, {
        align: 'center',
        url: 'https://github.com/NilsSchnorr/MeshNotes'
    });

    // ===== EXTRACT MANUAL CONTENT =====
    const manualItems = document.querySelectorAll('#about-modal-content .manual-item');
    const manualContent = [];

    manualItems.forEach(item => {
        const headerEl = item.querySelector('.manual-item-header');
        const contentEl = item.querySelector('.manual-item-content');

        if (headerEl && contentEl) {
            let title = headerEl.textContent.trim();
            title = title.replace(/[\u25B6\u25BC]$/, '').trim();

            const contentClone = contentEl.cloneNode(true);

            const paragraphs = [];

            function processLimitationNote(noteEl) {
                const noteContent = [];

                const clonedNote = noteEl.cloneNode(true);
                const nestedLists = clonedNote.querySelectorAll('ul');
                nestedLists.forEach(ul => ul.remove());
                const directText = clonedNote.textContent.trim();

                if (directText) {
                    noteContent.push({ type: 'note-text', text: directText });
                }

                const lists = noteEl.querySelectorAll('ul');
                lists.forEach(ul => {
                    const listItems = [];
                    ul.querySelectorAll('li').forEach(li => {
                        listItems.push(li.textContent.trim());
                    });
                    if (listItems.length > 0) {
                        noteContent.push({ type: 'note-list', items: listItems });
                    }
                });

                return { type: 'note', content: noteContent };
            }

            const allElements = contentClone.querySelectorAll('p, ul, .limitation-note');

            if (allElements.length > 0) {
                allElements.forEach(child => {
                    if (child.closest('.limitation-note') && !child.classList.contains('limitation-note')) {
                        return;
                    }

                    if (child.classList && child.classList.contains('limitation-note')) {
                        paragraphs.push(processLimitationNote(child));
                    } else if (child.tagName === 'UL') {
                        const listItems = [];
                        child.querySelectorAll('li').forEach(li => {
                            listItems.push(li.textContent.trim());
                        });
                        if (listItems.length > 0) {
                            paragraphs.push({ type: 'list', items: listItems });
                        }
                    } else {
                        paragraphs.push({ type: 'paragraph', text: child.textContent.trim() });
                    }
                });
            } else {
                paragraphs.push({ type: 'paragraph', text: contentEl.textContent.trim() });
            }

            manualContent.push({ title, paragraphs });
        }
    });

    // ===== ADD CONTENT PAGES =====
    pdf.addPage();
    yPos = margin;

    pdf.setFontSize(18);
    pdf.setTextColor(170, 129, 1);
    pdf.text('Table of Contents', margin, yPos);
    yPos += 12;

    pdf.setFontSize(11);
    pdf.setTextColor(60, 60, 60);
    manualContent.forEach((section, index) => {
        if (yPos > pageHeight - margin) {
            pdf.addPage();
            yPos = margin;
        }
        pdf.text(`${index + 1}. ${section.title}`, margin + 5, yPos);
        yPos += 7;
    });

    // ===== MANUAL SECTIONS =====
    manualContent.forEach((section, index) => {
        if (yPos > pageHeight - 60) {
            pdf.addPage();
            yPos = margin;
        } else {
            yPos += 10;
        }

        pdf.setFontSize(14);
        pdf.setTextColor(170, 129, 1);
        pdf.setFont(undefined, 'bold');
        pdf.text(`${index + 1}. ${section.title}`, margin, yPos);
        yPos += headerLineHeight + 2;

        pdf.setDrawColor(170, 129, 1);
        pdf.setLineWidth(0.3);
        pdf.line(margin, yPos - 4, margin + contentWidth, yPos - 4);
        yPos += 2;

        pdf.setFont(undefined, 'normal');
        pdf.setFontSize(10);

        section.paragraphs.forEach(para => {
            if (yPos > pageHeight - margin - 10) {
                pdf.addPage();
                yPos = margin;
            }

            if (para.type === 'note') {
                pdf.setFillColor(255, 248, 230);
                pdf.setDrawColor(232, 163, 60);

                let noteHeight = 8;
                const noteContentLines = [];

                para.content.forEach(item => {
                    if (item.type === 'note-text') {
                        const textLines = pdf.splitTextToSize(item.text, contentWidth - 14);
                        noteContentLines.push({ type: 'text', lines: textLines });
                        noteHeight += textLines.length * 5 + 2;
                    } else if (item.type === 'note-list') {
                        const listLines = [];
                        item.items.forEach(listItem => {
                            const itemLines = pdf.splitTextToSize('\u2022 ' + listItem, contentWidth - 20);
                            listLines.push(...itemLines);
                        });
                        noteContentLines.push({ type: 'list', lines: listLines });
                        noteHeight += listLines.length * 5 + 2;
                    }
                });

                if (yPos + noteHeight > pageHeight - margin) {
                    pdf.addPage();
                    yPos = margin;
                }

                pdf.roundedRect(margin, yPos - 2, contentWidth, noteHeight, 2, 2, 'FD');

                pdf.setTextColor(100, 80, 40);
                let noteYPos = yPos + 4;

                noteContentLines.forEach(content => {
                    if (content.type === 'text') {
                        content.lines.forEach(line => {
                            pdf.text(line, margin + 5, noteYPos);
                            noteYPos += 5;
                        });
                        noteYPos += 1;
                    } else if (content.type === 'list') {
                        content.lines.forEach(line => {
                            pdf.text(line, margin + 8, noteYPos);
                            noteYPos += 5;
                        });
                        noteYPos += 1;
                    }
                });

                yPos += noteHeight + 4;
            } else if (para.type === 'list') {
                pdf.setTextColor(60, 60, 60);

                para.items.forEach(item => {
                    const itemLines = pdf.splitTextToSize('\u2022 ' + item, contentWidth - 10);

                    itemLines.forEach((line, idx) => {
                        if (yPos > pageHeight - margin) {
                            pdf.addPage();
                            yPos = margin;
                        }
                        const xPos = idx === 0 ? margin + 5 : margin + 8;
                        pdf.text(line, xPos, yPos);
                        yPos += 5;
                    });
                });
                yPos += 3;
            } else {
                pdf.setTextColor(60, 60, 60);
                const textLines = pdf.splitTextToSize(para.text, contentWidth);

                textLines.forEach(line => {
                    if (yPos > pageHeight - margin) {
                        pdf.addPage();
                        yPos = margin;
                    }
                    pdf.text(line, margin, yPos);
                    yPos += 5;
                });
                yPos += 3;
            }
        });
    });

    // ===== FOOTER ON EACH PAGE =====
    const pageCount = pdf.internal.getNumberOfPages();
    pdf.setFontSize(8);
    pdf.setTextColor(150, 150, 150);

    for (let i = 1; i <= pageCount; i++) {
        pdf.setPage(i);
        pdf.text(
            `MeshNotes Manual - Page ${i} of ${pageCount}`,
            pageWidth / 2,
            pageHeight - 10,
            { align: 'center' }
        );
    }

    pdf.save(`MeshNotes-Manual-${new Date().toISOString().split('T')[0]}.pdf`);
}
