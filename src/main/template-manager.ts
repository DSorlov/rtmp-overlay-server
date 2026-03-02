import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export class TemplateManager {
  private templatesDir: string;

  constructor() {
    if (app.isPackaged) {
      this.templatesDir = path.join(process.resourcesPath, 'templates');
    } else {
      this.templatesDir = path.join(__dirname, '..', '..', 'templates');
    }
  }

  /**
   * List all available template files
   */
  listTemplates(): string[] {
    if (!fs.existsSync(this.templatesDir)) {
      return [];
    }
    return fs
      .readdirSync(this.templatesDir)
      .filter((f) => f.endsWith('.html'));
  }

  /**
   * Load a template file's raw HTML content
   */
  loadTemplate(name: string): string {
    const filePath = path.join(this.templatesDir, name);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Template not found: ${name}`);
    }

    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * Extract all unique {{placeholder}} names from a template file
   */
  getPlaceholders(name: string): string[] {
    const html = this.loadTemplate(name);
    const regex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
    const keys = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      keys.add(match[1]);
    }
    return Array.from(keys);
  }

  /**
   * Render a template by replacing {{placeholder}} tokens with provided data values.
   * Placeholders not found in data are replaced with empty string.
   */
  renderTemplate(html: string, data: Record<string, string>): string {
    let rendered = html;

    for (const [key, value] of Object.entries(data)) {
      const regex = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, 'g');
      rendered = rendered.replace(regex, value);
    }

    // Replace any remaining unmatched {{placeholder}} tokens with empty string
    rendered = rendered.replace(/\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/g, '');

    return rendered;
  }

  /**
   * Build a complete HTML page ready for off-screen rendering.
   * Forces chroma-key background and sets viewport to the given resolution.
   */
  buildOverlayPage(
    templateName: string,
    data: Record<string, string>,
    width: number,
    height: number,
    chromaKeyColor: string = '#00FF00',
  ): string {
    const rawHtml = this.loadTemplate(templateName);
    const renderedHtml = this.renderTemplate(rawHtml, data);

    // Wrap in a full page with forced chroma-key background and fixed dimensions
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    background: ${chromaKeyColor} !important;
  }
  #overlay-container {
    width: ${width}px;
    height: ${height}px;
    position: relative;
    background: transparent;
  }
</style>
</head>
<body>
<div id="overlay-container">
${renderedHtml}
</div>
<script>
  // Global functions callable from Electron main process via executeJavaScript
  window.updatePlaceholders = function(data) {
    const container = document.getElementById('overlay-container');
    if (!container) return;
    for (const [key, value] of Object.entries(data)) {
      const elements = container.querySelectorAll('[data-placeholder="' + key + '"]');
      elements.forEach(el => {
        if (el.tagName === 'IMG') {
          el.src = value || '';
          el.style.display = value ? '' : 'none';
        } else {
          el.textContent = value;
          // Hide elements with data-hide-empty when value is empty
          if (el.hasAttribute('data-hide-empty')) {
            el.style.display = value ? '' : 'none';
          }
        }
      });
      // Auto-hide parent containers that have data-hide-when-children-empty
      container.querySelectorAll('[data-hide-when-children-empty]').forEach(parent => {
        const children = parent.querySelectorAll('[data-hide-empty]');
        const allHidden = Array.from(children).every(c => !c.textContent && (c.tagName !== 'IMG' || !c.src));
        parent.style.display = allHidden ? 'none' : '';
      });
    }
  };

  window.replaceContent = function(html) {
    const container = document.getElementById('overlay-container');
    if (container) { container.innerHTML = html; }
  };

  // On initial load, hide empty placeholder elements
  (function() {
    const container = document.getElementById('overlay-container');
    if (!container) return;
    // Hide empty text elements with data-hide-empty
    container.querySelectorAll('[data-hide-empty]').forEach(el => {
      if (el.tagName === 'IMG') {
        if (!el.getAttribute('src')) el.style.display = 'none';
      } else {
        if (!el.textContent.trim()) el.style.display = 'none';
      }
    });
    // Hide parent containers where all children are empty
    container.querySelectorAll('[data-hide-when-children-empty]').forEach(parent => {
      const children = parent.querySelectorAll('[data-hide-empty]');
      const allHidden = Array.from(children).every(c => {
        if (c.tagName === 'IMG') return !c.getAttribute('src');
        return !c.textContent.trim();
      });
      if (allHidden) parent.style.display = 'none';
    });
  })();
</script>
</body>
</html>`;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
