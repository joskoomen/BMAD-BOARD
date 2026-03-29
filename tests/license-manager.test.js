import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LicenseManager } from '../lib/license-manager.js';

let tmpDir;
let prefsPath;
let manager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-test-'));
  prefsPath = path.join(tmpDir, 'preferences.json');
  manager = new LicenseManager(prefsPath);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
  vi.restoreAllMocks();
});

describe('LicenseManager', () => {
  describe('getStatus', () => {
    it('returns inactive when no license', () => {
      const status = manager.getStatus();
      expect(status.active).toBe(false);
      expect(status.plan).toBeNull();
    });

    it('returns active when cache has active status', () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: {
          key: 'TEST-KEY',
          instanceId: 'inst-1',
          status: 'active',
          customerEmail: 'test@example.com',
          productName: 'BMAD Board Pro',
          variantName: 'monthly',
          validatedAt: new Date().toISOString(),
        }
      }));

      const m = new LicenseManager(prefsPath);
      const status = m.getStatus();
      expect(status.active).toBe(true);
      expect(status.plan).toBe('monthly');
      expect(status.customerEmail).toBe('test@example.com');
    });

    it('returns inactive when status is not active', () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: {
          key: 'TEST-KEY',
          status: 'expired',
          validatedAt: new Date().toISOString(),
        }
      }));

      const m = new LicenseManager(prefsPath);
      expect(m.getStatus().active).toBe(false);
    });
  });

  describe('needsRevalidation', () => {
    it('returns false when no license key', () => {
      expect(manager.needsRevalidation()).toBe(false);
    });

    it('returns true when no validatedAt', () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: { key: 'TEST-KEY', status: 'active' }
      }));
      const m = new LicenseManager(prefsPath);
      expect(m.needsRevalidation()).toBe(true);
    });

    it('returns false when validated recently', () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: {
          key: 'TEST-KEY',
          status: 'active',
          validatedAt: new Date().toISOString(),
        }
      }));
      const m = new LicenseManager(prefsPath);
      expect(m.needsRevalidation()).toBe(false);
    });

    it('returns true when validated over 24h ago', () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: {
          key: 'TEST-KEY',
          status: 'active',
          validatedAt: old,
        }
      }));
      const m = new LicenseManager(prefsPath);
      expect(m.needsRevalidation()).toBe(true);
    });
  });

  describe('activate', () => {
    it('rejects empty key', async () => {
      const result = await manager.activate('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid license key');
    });

    it('rejects null key', async () => {
      const result = await manager.activate(null);
      expect(result.success).toBe(false);
    });

    it('handles API success', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          activated: true,
          instance: { id: 'inst-123' },
          meta: {
            customer_email: 'user@test.com',
            product_name: 'BMAD Board Pro',
            variant_name: 'annual',
          },
        }),
      });

      const result = await manager.activate('VALID-KEY');
      expect(result.success).toBe(true);
      expect(manager.getStatus().active).toBe(true);
      expect(manager.getStatus().plan).toBe('annual');
      expect(manager.getStatus().customerEmail).toBe('user@test.com');

      // Verify cached to disk
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      expect(prefs.license.key).toBe('VALID-KEY');
      expect(prefs.license.status).toBe('active');
    });

    it('handles API failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ activated: false, error: 'Invalid key' }),
      });

      const result = await manager.activate('BAD-KEY');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid key');
    });

    it('handles network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network timeout'));

      const result = await manager.activate('SOME-KEY');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });
  });

  describe('validate', () => {
    it('fails when no key stored', async () => {
      const result = await manager.validate();
      expect(result.valid).toBe(false);
    });

    it('validates a stored key', async () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: { key: 'STORED-KEY', status: 'active', validatedAt: '2024-01-01T00:00:00Z' }
      }));
      const m = new LicenseManager(prefsPath);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          valid: true,
          meta: { customer_email: 'new@test.com' },
        }),
      });

      const result = await m.validate();
      expect(result.valid).toBe(true);
      expect(m.getStatus().active).toBe(true);
    });

    it('keeps cached status on network error (offline-first)', async () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: { key: 'MY-KEY', status: 'active', validatedAt: '2024-01-01T00:00:00Z' }
      }));
      const m = new LicenseManager(prefsPath);

      global.fetch = vi.fn().mockRejectedValue(new Error('No internet'));

      const result = await m.validate();
      expect(result.valid).toBe(true);
      expect(result.error).toBe('No internet');
    });

    it('marks invalid when API says expired', async () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: { key: 'MY-KEY', status: 'active', validatedAt: '2024-01-01T00:00:00Z' }
      }));
      const m = new LicenseManager(prefsPath);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          valid: false,
          error: 'License expired',
          license_key: { status: 'expired' },
        }),
      });

      const result = await m.validate();
      expect(result.valid).toBe(false);
      expect(m.getStatus().active).toBe(false);
    });
  });

  describe('deactivate', () => {
    it('clears cached license', async () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: { key: 'MY-KEY', status: 'active', instanceId: 'inst-1' }
      }));
      const m = new LicenseManager(prefsPath);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ deactivated: true }),
      });

      const result = await m.deactivate();
      expect(result.success).toBe(true);
      expect(m.getStatus().active).toBe(false);

      // Verify removed from disk
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      expect(prefs.license).toBeUndefined();
    });

    it('clears locally even on network error', async () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        license: { key: 'MY-KEY', status: 'active' }
      }));
      const m = new LicenseManager(prefsPath);

      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await m.deactivate();
      expect(result.success).toBe(true);
      expect(m.getStatus().active).toBe(false);
    });

    it('fails when no key stored', async () => {
      const result = await manager.deactivate();
      expect(result.success).toBe(false);
    });
  });

  describe('getCheckoutUrl', () => {
    it('returns monthly URL by default', () => {
      const url = manager.getCheckoutUrl('monthly');
      expect(url).toContain('YOUR_MONTHLY_VARIANT_ID');
      expect(url).toContain('embed=1');
    });

    it('returns annual URL', () => {
      const url = manager.getCheckoutUrl('annual');
      expect(url).toContain('YOUR_ANNUAL_VARIANT_ID');
    });
  });

  describe('isConfigured', () => {
    it('returns false with placeholder values', () => {
      expect(manager.isConfigured()).toBe(false);
    });
  });

  describe('cache persistence', () => {
    it('preserves other prefs when saving license', async () => {
      fs.writeFileSync(prefsPath, JSON.stringify({
        lastProjectPath: '/my/project',
        theme: 'dark',
      }));

      const m = new LicenseManager(prefsPath);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          activated: true,
          instance: { id: 'inst-1' },
          meta: { variant_name: 'monthly' },
        }),
      });

      await m.activate('KEY-123');

      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      expect(prefs.lastProjectPath).toBe('/my/project');
      expect(prefs.theme).toBe('dark');
      expect(prefs.license.key).toBe('KEY-123');
    });

    it('handles corrupt prefs file gracefully', () => {
      fs.writeFileSync(prefsPath, 'not valid json');
      const m = new LicenseManager(prefsPath);
      expect(m.getStatus().active).toBe(false);
    });

    it('handles missing prefs file gracefully', () => {
      const m = new LicenseManager(path.join(tmpDir, 'nonexistent.json'));
      expect(m.getStatus().active).toBe(false);
    });
  });

  describe('trial', () => {
    it('rejects trial without email', () => {
      const result = manager.startTrial('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Valid email address required');
    });

    it('rejects trial with invalid email', () => {
      const result = manager.startTrial('not-an-email');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Valid email address required');
    });

    it('starts trial with valid email', () => {
      const result = manager.startTrial('user@example.com');
      expect(result.success).toBe(true);

      const status = manager.getStatus();
      expect(status.active).toBe(true);
      expect(status.trial).toBe(true);
      expect(status.plan).toBe('trial');
      expect(status.trialDaysLeft).toBe(14);
      expect(status.trialUsed).toBe(true);
    });

    it('stores email in trial data', () => {
      manager.startTrial('test@domain.com');
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      expect(prefs.trial.email).toBe('test@domain.com');
    });

    it('normalizes email to lowercase', () => {
      manager.startTrial('User@Example.COM');
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      expect(prefs.trial.email).toBe('user@example.com');
    });

    it('rejects second trial', () => {
      manager.startTrial('first@example.com');
      const result = manager.startTrial('second@example.com');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Trial already used');
    });

    it('shows trial as expired after 14 days', () => {
      // Write a trial that started 15 days ago
      const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(prefsPath, JSON.stringify({
        trial: { email: 'user@test.com', startedAt: old, durationMs: 14 * 24 * 60 * 60 * 1000 }
      }));
      const m = new LicenseManager(prefsPath);

      const status = m.getStatus();
      expect(status.active).toBe(false);
      expect(status.trial).toBe(false);
      expect(status.trialUsed).toBe(true);
      expect(status.trialDaysLeft).toBe(0);
    });

    it('shows correct days remaining during trial', () => {
      // Trial started 10 days ago → 4 days left
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(prefsPath, JSON.stringify({
        trial: { email: 'user@test.com', startedAt: tenDaysAgo, durationMs: 14 * 24 * 60 * 60 * 1000 }
      }));
      const m = new LicenseManager(prefsPath);

      const status = m.getStatus();
      expect(status.active).toBe(true);
      expect(status.trial).toBe(true);
      expect(status.trialDaysLeft).toBe(4);
    });

    it('license takes precedence over trial', () => {
      // Both trial and license active
      fs.writeFileSync(prefsPath, JSON.stringify({
        trial: { email: 'user@test.com', startedAt: new Date().toISOString(), durationMs: 14 * 24 * 60 * 60 * 1000 },
        license: { key: 'MY-KEY', status: 'active', variantName: 'monthly', validatedAt: new Date().toISOString() }
      }));
      const m = new LicenseManager(prefsPath);

      const status = m.getStatus();
      expect(status.active).toBe(true);
      expect(status.trial).toBe(false);
      expect(status.plan).toBe('monthly');
    });

    it('getTrialStatus returns not used when no trial', () => {
      const status = manager.getTrialStatus();
      expect(status.active).toBe(false);
      expect(status.used).toBe(false);
      expect(status.daysLeft).toBe(0);
    });
  });
});
