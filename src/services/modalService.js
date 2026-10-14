// Unified In-App Modal & Notification Service (Impeccable Design Standard)
// Completely replaces browser native window.alert(), window.confirm(), and window.prompt()

import { isCloudflareMode } from '../config/backendMode.js';

class ModalService {
  constructor() {
    this.listeners = new Set();
    this.currentModal = null;
    this._lastErrorAt = 0;
    this._lastErrorAuto = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach(listener => listener(this.currentModal));
  }

  /**
   * Show a generic alert modal
   * @param {string|Object} titleOrConfig
   * @param {string} [message]
   * @param {'info'|'success'|'warning'|'error'} [type='info']
   */
  alert(titleOrConfig, message = '', type = 'info') {
    return new Promise((resolve) => {
      let config = {};
      if (typeof titleOrConfig === 'object' && titleOrConfig !== null) {
        config = titleOrConfig;
      } else {
        config = {
          title: message ? titleOrConfig : (type === 'error' ? 'เกิดข้อผิดพลาด' : type === 'success' ? 'ดำเนินการสำเร็จ' : type === 'warning' ? 'แจ้งเตือน' : 'ข้อมูล'),
          message: message || titleOrConfig,
          type: type || 'info'
        };
      }

      this.currentModal = {
        ...config,
        mode: 'alert',
        confirmText: config.confirmText || 'ตกลง',
        onConfirm: () => {
          this.close();
          resolve(true);
        },
        onClose: () => {
          this.close();
          resolve(true);
        }
      };
      this.notify();
    });
  }

  /**
   * Show a success modal
   */
  success(title, message = '', options = {}) {
    return this.alert({
      title: message ? title : 'ดำเนินการสำเร็จ',
      message: message || title,
      type: 'success',
      confirmText: options.confirmText || 'ตกลง',
      ...options
    });
  }

  /**
   * Show an error modal
   */
  error(title, message = '', options = {}) {
    // Cloudflare mode only: one error modal per failed action. The automatic safety-net modal from
    // cfGuard (cfAuto) is skipped when a modal was just shown, and a caller's own modal is skipped
    // if the automatic one already appeared. mock / gas are untouched.
    if (isCloudflareMode()) {
      const now = Date.now();
      const recent = now - this._lastErrorAt < 800;
      if (recent && (options?.cfAuto || this._lastErrorAuto)) return Promise.resolve(true);
      this._lastErrorAt = now;
      this._lastErrorAuto = Boolean(options?.cfAuto);
    }
    const errObj = options?.error || (message instanceof Error ? message : null) || (title instanceof Error ? title : null);
    if (errObj) {
      console.error('[Workflow Error Stack]:', errObj.stack || errObj);
    } else {
      console.error('[Workflow Error Stack]:', message || title);
    }
    return this.alert({
      title: message ? (typeof title === 'string' ? title : 'เกิดข้อผิดพลาด') : 'เกิดข้อผิดพลาด',
      message: message ? (message?.message || String(message)) : (title?.message || String(title)),
      type: 'error',
      confirmText: options.confirmText || 'เข้าใจแล้ว',
      ...options
    });
  }

  /**
   * Show a warning modal
   */
  warning(title, message = '', options = {}) {
    return this.alert({
      title: message ? title : 'แจ้งเตือน',
      message: message || title,
      type: 'warning',
      confirmText: options.confirmText || 'รับทราบ',
      ...options
    });
  }

  /**
   * Show an info modal
   */
  info(title, message = '', options = {}) {
    return this.alert({
      title: message ? title : 'ข้อมูลระบบ',
      message: message || title,
      type: 'info',
      confirmText: options.confirmText || 'ตกลง',
      ...options
    });
  }

  /**
   * Show a confirmation modal (Replaces window.confirm)
   * @param {string|Object} titleOrConfig
   * @param {string} [message]
   * @param {Object} [options]
   * @returns {Promise<boolean>}
   */
  confirm(titleOrConfig, message = '', options = {}) {
    return new Promise((resolve) => {
      let config = {};
      if (typeof titleOrConfig === 'object' && titleOrConfig !== null) {
        config = titleOrConfig;
      } else {
        config = {
          title: message ? titleOrConfig : 'ยืนยันการทำรายการ',
          message: message || titleOrConfig,
          type: options.type || 'warning',
          ...options
        };
      }

      this.currentModal = {
        ...config,
        mode: 'confirm',
        type: config.type || 'warning',
        confirmText: config.confirmText || 'ยืนยัน',
        cancelText: config.cancelText || 'ยกเลิก',
        variant: config.variant || (config.type === 'error' ? 'danger' : config.type === 'success' ? 'success' : 'primary'),
        onConfirm: () => {
          this.close();
          resolve(true);
        },
        onCancel: () => {
          this.close();
          resolve(false);
        },
        onClose: () => {
          this.close();
          resolve(false);
        }
      };
      this.notify();
    });
  }

  /**
   * Show a text prompt modal (Replaces window.prompt)
   * @param {string|Object} titleOrConfig
   * @param {string} [message]
   * @param {Object} [options]
   * @returns {Promise<string|null>}
   */
  prompt(titleOrConfig, message = '', options = {}) {
    return new Promise((resolve) => {
      let config = {};
      if (typeof titleOrConfig === 'object' && titleOrConfig !== null) {
        config = titleOrConfig;
      } else {
        config = {
          title: message ? titleOrConfig : 'กรุณากรอกข้อมูล',
          message: message || titleOrConfig,
          ...options
        };
      }

      this.currentModal = {
        ...config,
        mode: 'prompt',
        type: config.type || 'info',
        placeholder: config.placeholder || 'ระบุรายละเอียด...',
        defaultValue: config.defaultValue || '',
        required: config.required !== false,
        confirmText: config.confirmText || 'ตกลง',
        cancelText: config.cancelText || 'ยกเลิก',
        onConfirm: (value) => {
          this.close();
          resolve(value);
        },
        onCancel: () => {
          this.close();
          resolve(null);
        },
        onClose: () => {
          this.close();
          resolve(null);
        }
      };
      this.notify();
    });
  }

  close() {
    this.currentModal = null;
    this.notify();
  }
}

export const modalService = new ModalService();
