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
const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const LICENSE_CACHE_KEY = 'license';
const TRIAL_CACHE_KEY = 'trial';

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
   * Start a 14-day Pro trial. Requires an email address.
   * @param {string} email - User's email address
   * @returns {{success: boolean, error?: string}}
   */
  startTrial(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return { success: false, error: 'Valid email address required' };
    }

    const trial = this._loadTrial();
    if (trial) {
      return { success: false, error: 'Trial already used' };
    }

    const trialData = {
      email: email.trim().toLowerCase(),
      startedAt: new Date().toISOString(),
      durationMs: TRIAL_DURATION_MS,
    };
    this._saveTrial(trialData);
    return { success: true };
  }

  /**
   * Get trial status.
   * @returns {{active: boolean, daysLeft: number, used: boolean}}
   */
  getTrialStatus() {
    const trial = this._loadTrial();
    if (!trial) {
      return { active: false, daysLeft: 0, used: false };
    }

    const elapsed = Date.now() - new Date(trial.startedAt).getTime();
    const duration = trial.durationMs || TRIAL_DURATION_MS;
    const remaining = duration - elapsed;

    if (remaining <= 0) {
      return { active: false, daysLeft: 0, used: true };
    }

    return {
      active: true,
      daysLeft: Math.ceil(remaining / (24 * 60 * 60 * 1000)),
      used: true,
    };
  }

  /**
   * Get current license status (sync, for renderer).
   * Includes trial — Pro is active if license OR trial is active.
   * @returns {{active: boolean, plan: string|null, trial: boolean, trialDaysLeft: number, trialUsed: boolean, customerEmail: string|null, productName: string|null}}
   */
  getStatus() {
    const trialStatus = this.getTrialStatus();

    // Licensed user
    if (this.cache && this.cache.status === 'active') {
      return {
        active: true,
        plan: this.cache.variantName || null,
        trial: false,
        trialDaysLeft: 0,
        trialUsed: trialStatus.used,
        customerEmail: this.cache.customerEmail || null,
        productName: this.cache.productName || null,
      };
    }

    // Active trial
    if (trialStatus.active) {
      return {
        active: true,
        plan: 'trial',
        trial: true,
        trialDaysLeft: trialStatus.daysLeft,
        trialUsed: true,
        customerEmail: null,
        productName: null,
      };
    }

    // Free tier
    return {
      active: false,
      plan: null,
      trial: false,
      trialDaysLeft: 0,
      trialUsed: trialStatus.used,
      customerEmail: null,
      productName: null,
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
    this._writePrefsKey(LICENSE_CACHE_KEY, this.cache);
  }

  /**
   * Load trial data from preferences file.
   * @returns {object|null}
   */
  _loadTrial() {
    try {
      if (fs.existsSync(this.prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(this.prefsPath, 'utf-8'));
        return prefs[TRIAL_CACHE_KEY] || null;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Save trial data to preferences file.
   * @param {object} trialData
   */
  _saveTrial(trialData) {
    this._writePrefsKey(TRIAL_CACHE_KEY, trialData);
  }

  /**
   * Write a key to the preferences file, preserving other data.
   * @param {string} key
   * @param {*} value - null/undefined removes the key
   */
  _writePrefsKey(key, value) {
    try {
      let prefs = {};
      if (fs.existsSync(this.prefsPath)) {
        prefs = JSON.parse(fs.readFileSync(this.prefsPath, 'utf-8'));
      }
      if (value != null) {
        prefs[key] = value;
      } else {
        delete prefs[key];
      }
      const dir = path.dirname(this.prefsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.prefsPath, JSON.stringify(prefs, null, 2));
    } catch { /* ignore write errors */ }
  }
}

module.exports = { LicenseManager, LEMON_SQUEEZY_CONFIG };
