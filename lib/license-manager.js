/**
 * License Manager — Lemon Squeezy license validation, activation, and caching.
 *
 * Manages subscription state for BMAD Board Pro.
 * Validates licenses against Lemon Squeezy API with offline-first caching.
 *
 * Usage:
 *   const { LicenseManager } = require('./lib/license-manager');
 *   const lm = new LicenseManager(prefsPath);
 *   await lm.activate('XXXX-XXXX-XXXX-XXXX');
 *   lm.getStatus(); // { active: true, plan: 'monthly', ... }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Lemon Squeezy Configuration ──────────────────────────────────────────
// Fill in these values after creating your Lemon Squeezy product.

const LEMON_SQUEEZY_CONFIG = {
  storeSlug: 'YOUR_STORE',                     // Your Lemon Squeezy store slug
  monthlyVariantId: 'YOUR_MONTHLY_VARIANT_ID',  // Variant ID for monthly plan
  annualVariantId: 'YOUR_ANNUAL_VARIANT_ID',     // Variant ID for annual plan
  apiBaseUrl: 'https://api.lemonsqueezy.com/v1/licenses',
};

const REVALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LICENSE_CACHE_KEY = 'license';

class LicenseManager {
  /**
   * @param {string} prefsPath - Absolute path to preferences.json
   */
  constructor(prefsPath) {
    this.prefsPath = prefsPath;
    this.cache = this._loadCache();
  }

  /**
   * Activate a license key with Lemon Squeezy.
   * @param {string} licenseKey - The license key to activate
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async activate(licenseKey) {
    if (!licenseKey || typeof licenseKey !== 'string') {
      return { success: false, error: 'Invalid license key' };
    }

    const key = licenseKey.trim();

    try {
      const res = await this._apiCall('/activate', {
        license_key: key,
        instance_name: os.hostname(),
      });

      if (res.activated || res.valid) {
        this.cache = {
          key,
          instanceId: res.instance?.id || null,
          status: 'active',
          customerEmail: res.meta?.customer_email || null,
          productName: res.meta?.product_name || null,
          variantName: res.meta?.variant_name || null,
          validatedAt: new Date().toISOString(),
        };
        this._saveCache();
        return { success: true };
      }

      return { success: false, error: res.error || 'Activation failed' };
    } catch (err) {
      return { success: false, error: err.message || 'Network error' };
    }
  }

  /**
   * Validate the currently stored license key.
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async validate() {
    if (!this.cache || !this.cache.key) {
      return { valid: false, error: 'No license key stored' };
    }

    try {
      const res = await this._apiCall('/validate', {
        license_key: this.cache.key,
        instance_name: os.hostname(),
      });

      if (res.valid) {
        this.cache.status = 'active';
        this.cache.validatedAt = new Date().toISOString();
        this.cache.customerEmail = res.meta?.customer_email || this.cache.customerEmail;
        this.cache.productName = res.meta?.product_name || this.cache.productName;
        this.cache.variantName = res.meta?.variant_name || this.cache.variantName;
        this._saveCache();
        return { valid: true };
      }

      // License expired or revoked
      this.cache.status = res.license_key?.status || 'invalid';
      this._saveCache();
      return { valid: false, error: res.error || 'License is no longer valid' };
    } catch (err) {
      // Network error — keep cached status (offline-first)
      return { valid: this.cache.status === 'active', error: err.message };
    }
  }

  /**
   * Deactivate the current license on this machine.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deactivate() {
    if (!this.cache || !this.cache.key) {
      return { success: false, error: 'No license key stored' };
    }

    try {
      const body = { license_key: this.cache.key };
      if (this.cache.instanceId) body.instance_id = this.cache.instanceId;

      await this._apiCall('/deactivate', body);
    } catch {
      // Deactivation failed remotely — still clear locally
    }

    this.cache = null;
    this._saveCache();
    return { success: true };
  }

  /**
   * Get current license status (sync, for renderer).
   * @returns {{active: boolean, plan: string|null, customerEmail: string|null, productName: string|null}}
   */
  getStatus() {
    if (!this.cache || this.cache.status !== 'active') {
      return { active: false, plan: null, customerEmail: null, productName: null };
    }

    return {
      active: true,
      plan: this.cache.variantName || null,
      customerEmail: this.cache.customerEmail || null,
      productName: this.cache.productName || null,
    };
  }

  /**
   * Check if license needs re-validation (>24h since last check).
   * @returns {boolean}
   */
  needsRevalidation() {
    if (!this.cache || !this.cache.key) return false;
    if (!this.cache.validatedAt) return true;
    const elapsed = Date.now() - new Date(this.cache.validatedAt).getTime();
    return elapsed > REVALIDATION_INTERVAL_MS;
  }

  /**
   * Get the checkout URL for a given plan.
   * @param {'monthly'|'annual'} plan
   * @returns {string}
   */
  getCheckoutUrl(plan) {
    const variantId = plan === 'annual'
      ? LEMON_SQUEEZY_CONFIG.annualVariantId
      : LEMON_SQUEEZY_CONFIG.monthlyVariantId;

    return `https://${LEMON_SQUEEZY_CONFIG.storeSlug}.lemonsqueezy.com/checkout/buy/${variantId}?embed=1&media=0`;
  }

  /**
   * Check if the Lemon Squeezy store is configured (not placeholder values).
   * @returns {boolean}
   */
  isConfigured() {
    return LEMON_SQUEEZY_CONFIG.storeSlug !== 'YOUR_STORE'
      && LEMON_SQUEEZY_CONFIG.monthlyVariantId !== 'YOUR_MONTHLY_VARIANT_ID';
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Make a POST request to the Lemon Squeezy license API.
   * @param {string} endpoint - e.g. '/activate', '/validate', '/deactivate'
   * @param {object} body - Request body
   * @returns {Promise<object>} Parsed JSON response
   */
  async _apiCall(endpoint, body) {
    const url = LEMON_SQUEEZY_CONFIG.apiBaseUrl + endpoint;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${text}`);
    }

    return res.json();
  }

  /**
   * Load cached license data from preferences file.
   * @returns {object|null}
   */
  _loadCache() {
    try {
      if (fs.existsSync(this.prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(this.prefsPath, 'utf-8'));
        return prefs[LICENSE_CACHE_KEY] || null;
      }
    } catch { /* ignore corrupt prefs */ }
    return null;
  }

  /**
   * Save cached license data to preferences file.
   */
  _saveCache() {
    try {
      let prefs = {};
      if (fs.existsSync(this.prefsPath)) {
        prefs = JSON.parse(fs.readFileSync(this.prefsPath, 'utf-8'));
      }
      if (this.cache) {
        prefs[LICENSE_CACHE_KEY] = this.cache;
      } else {
        delete prefs[LICENSE_CACHE_KEY];
      }
      const dir = path.dirname(this.prefsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.prefsPath, JSON.stringify(prefs, null, 2));
    } catch { /* ignore write errors */ }
  }
}

module.exports = { LicenseManager, LEMON_SQUEEZY_CONFIG };
