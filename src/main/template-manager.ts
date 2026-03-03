import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';

/**
 * Describes a bundled template that has been updated and differs from the user's copy.
 */
export interface TemplateUpdateInfo {
  name: string;
}

export class TemplateManager {
  /** Bundled (read-only) templates shipped with the app */
  private bundledDir: string;
  /** User-writable templates directory in ~/Documents/RTMP Overlay Server/templates */
  private userDir: string;

  constructor() {
    // Bundled templates location
    if (app.isPackaged) {
      this.bundledDir = path.join(process.resourcesPath, 'templates');
    } else {
      this.bundledDir = path.join(__dirname, '..', '..', 'templates');
    }

    // User templates location: ~/Documents/RTMP Overlay Server/templates
    const docsDir = app.getPath('documents');
    this.userDir = path.join(docsDir, 'RTMP Overlay Server', 'templates');
  }

  /**
   * Returns the user templates directory path.
   */
  getUserTemplatesDir(): string {
    return this.userDir;
  }

  /**
   * Ensure the user templates directory exists.
   */
  private ensureUserDir(): void {
    if (!fs.existsSync(this.userDir)) {
      fs.mkdirSync(this.userDir, { recursive: true });
      console.log('[TemplateManager] Created user templates dir:', this.userDir);
    }
  }

  /**
   * Get SHA-256 hash of a file's contents.
   */
  private hashFile(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * List all bundled template filenames.
   */
  private listBundled(): string[] {
    if (!fs.existsSync(this.bundledDir)) return [];
    return fs.readdirSync(this.bundledDir).filter(f => f.endsWith('.html'));
  }

  /**
   * Synchronise bundled templates → user directory.
   *   - New templates (not in user dir) are copied automatically.
   *   - Updated templates (hash differs) are returned so the caller can prompt the user.
   *
   * Returns the list of templates that have newer bundled versions but already exist
   * (modified or not) in the user directory.
   */
  syncTemplates(): TemplateUpdateInfo[] {
    this.ensureUserDir();

    const bundled = this.listBundled();
    const updatedTemplates: TemplateUpdateInfo[] = [];

    for (const name of bundled) {
      const bundledPath = path.join(this.bundledDir, name);
      const userPath = path.join(this.userDir, name);

      if (!fs.existsSync(userPath)) {
        // First-time copy — user doesn't have this template yet
        fs.copyFileSync(bundledPath, userPath);
        console.log(`[TemplateManager] Copied new template: ${name}`);
      } else {
        // Compare hashes
        const bundledHash = this.hashFile(bundledPath);
        const userHash = this.hashFile(userPath);
        if (bundledHash !== userHash) {
          updatedTemplates.push({ name });
        }
      }
    }

    return updatedTemplates;
  }

  /**
   * Overwrite specific user templates with their bundled versions.
   */
  applyBundledUpdates(names: string[]): void {
    for (const name of names) {
      const bundledPath = path.join(this.bundledDir, name);
      const userPath = path.join(this.userDir, name);
      if (fs.existsSync(bundledPath)) {
        fs.copyFileSync(bundledPath, userPath);
        console.log(`[TemplateManager] Updated user template: ${name}`);
      }
    }
  }

  /**
   * List all available template files from the user templates directory.
   */
  listTemplates(): string[] {
    this.ensureUserDir();
    return fs
      .readdirSync(this.userDir)
      .filter((f) => f.endsWith('.html'));
  }

  /**
   * Load a template file's raw HTML content from the user directory.
   */
  loadTemplate(name: string): string {
    const filePath = path.join(this.userDir, name);

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

  // ── Subtitle support ──
  // Creates a subtitle container and exposes window.addSubtitle(text)
  // that displays classic TV-style captions at the bottom of the overlay.
  (function() {
    // Create subtitle container
    var subContainer = document.createElement('div');
    subContainer.id = 'subtitle-container';
    subContainer.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);max-width:80%;text-align:center;z-index:10000;pointer-events:none;';
    document.body.appendChild(subContainer);

    // Add subtitle CSS
    var subStyle = document.createElement('style');
    subStyle.textContent = [
      '.subtitle-line { display:block; background:rgba(0,0,0,0.75); color:#FFF;',
      'font-family:Arial,Helvetica Neue,sans-serif; font-size:28px; font-weight:600;',
      'line-height:1.4; padding:8px 20px; border-radius:4px; margin-bottom:4px;',
      'text-shadow:1px 1px 2px rgba(0,0,0,0.8); animation:subtitleFadeIn 0.3s ease-out; }',
      '.subtitle-line.fading { animation:subtitleFadeOut 0.5s ease-in forwards; }',
      '@keyframes subtitleFadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }',
      '@keyframes subtitleFadeOut { from{opacity:1} to{opacity:0} }',
    ].join(' ');
    document.head.appendChild(subStyle);

    var subtitleTimeout = null;
    window.addSubtitle = function(text) {
      if (!text || !text.trim()) return;
      // Clear previous fade-out timer
      if (subtitleTimeout) clearTimeout(subtitleTimeout);

      // Create new line
      var line = document.createElement('div');
      line.className = 'subtitle-line';
      line.textContent = text.trim();
      subContainer.appendChild(line);

      // Keep at most 2 lines
      while (subContainer.children.length > 2) {
        subContainer.removeChild(subContainer.firstChild);
      }

      // Auto-fade after 5 seconds
      subtitleTimeout = setTimeout(function() {
        var children = Array.from(subContainer.children);
        children.forEach(function(el) { el.classList.add('fading'); });
        setTimeout(function() { subContainer.innerHTML = ''; }, 500);
      }, 5000);
    };
  })();

  // ── Timer support ──
  // Exposes window.updateTimer(display, running) which pushes the formatted
  // time string into any element with a data-timer attribute.
  (function() {
    window.updateTimer = function(display, running) {
      var els = document.querySelectorAll('[data-timer]');
      els.forEach(function(el) {
        el.textContent = display;
        // Always show the element when it has content
        if (display) el.style.display = '';
        if (running) {
          el.classList.add('timer-running');
          el.classList.remove('timer-stopped');
        } else {
          el.classList.remove('timer-running');
          el.classList.add('timer-stopped');
        }
      });
    };
  })();

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
