(function () {
  // ====== 原有自动填表功能 ======
  // 默认值设为空，用户需要在扩展选项中配置
  const DEFAULT_EMAIL = '';
  const DEFAULT_PASSWORD = '';
  const DEFAULT_USERNAME = '';

  async function fillInputs() {
    const allInputs = Array.from(document.querySelectorAll('input'));
    const allTextareas = Array.from(document.querySelectorAll('textarea'));
    const hasPasswordInput = allInputs.some(
      (input) => (input.type || '').toLowerCase() === 'password'
    );
    const WEBSITE = await getWebsiteUrl();
    const userProfile = await getUserProfile({
      includePassword: hasPasswordInput
    });
    const EMAIL = userProfile.email;
    const USERNAME = userProfile.name;
    const PASSWORD = userProfile.password;

    // 填邮箱（全局优先填第一个看起来像 Email 的输入框）
    const emailCandidates = allInputs.filter((input) => {
      const type = (input.type || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();

      if (type === 'hidden') return false;

      if (type === 'email') return true;

      const keywords = ['email', 'e-mail', 'mail'];
      return keywords.some((k) => name.includes(k) || id.includes(k) || placeholder.includes(k));
    });

    if (emailCandidates.length > 0) {
      const emailInput = emailCandidates[0];
      setValue(emailInput, EMAIL);
    }

    // 填用户名（尽量匹配"用户名 / 账号 / 昵称 / login / username"等字段）
    const usernameCandidates = allInputs.filter((input) => {
      const type = (input.type || '').toLowerCase();
      if (type === 'email' || type === 'password' || type === 'checkbox' || type === 'radio') {
        return false;
      }

      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      const text = `${name} ${id} ${placeholder}`;

      const keywords = [
        'user',
        'username',
        'account',
        'login',
        'nick',
        'nickname',
        'handle',
        '用户名',
        '账号',
        '帐户',
        '登录名',
        '昵称'
      ];

      return keywords.some((k) => text.includes(k));
    });

    if (usernameCandidates.length > 0) {
      const usernameInput = usernameCandidates[0];
      setValue(usernameInput, USERNAME);
    }

    // 填密码（通常有两个：密码和确认密码）
    const passwordInputs = allInputs.filter(
      (input) => (input.type || '').toLowerCase() === 'password'
    );

    if (passwordInputs.length > 0) {
      passwordInputs.forEach((input) => {
        setValue(input, PASSWORD);
      });
    }

    // ====== 针对"评论表单"的增强逻辑：自动填 Name / Email / Website ======
    const commentForms = new Set();
    allTextareas.forEach((ta) => {
      const name = (ta.name || '').toLowerCase();
      const id = (ta.id || '').toLowerCase();
      const placeholder = (ta.placeholder || '').toLowerCase();
      const text = `${name} ${id} ${placeholder}`;
      const keywords = [
        'comment',
        'comentario',
        'reply',
        'respuesta',
        'message',
        'mensaje',
        'review',
        'reseña',
        'feedback',
        'opinion',
        'opinión',
        'commenttext',
        '留言',
        '评论',
        '回复'
      ];
      if (keywords.some((k) => text.includes(k))) {
        const form = ta.form || (ta.closest && ta.closest('form'));
        if (form) {
          commentForms.add(form);
        }
      }
    });

    if (commentForms.size === 0) {
      const forms = Array.from(document.querySelectorAll('form'));
      forms.forEach((form) => {
        const text = (form.textContent || '').toLowerCase();
        const className = (form.className || '').toLowerCase();
        const id = (form.id || '').toLowerCase();

        const keywords = [
          'deja una respuesta',
          'deja un comentario',
          'tu dirección de correo electrónico no será publicada',
          'comentario *',
          'leave a reply',
          'leave a comment',
          'post comment',
          'submit comment',
          'reply',
          'respond',
          '评论',
          '留言',
          '回复'
        ];

        const wpClassNames = ['comment-form', 'commentform', 'respond', 'comment-respond'];

        if (keywords.some((k) => text.includes(k)) ||
            wpClassNames.some(c => className.includes(c) || id.includes(c))) {
          commentForms.add(form);
        }
      });
    }

    if (commentForms.size === 0) {
      const commentAreas = document.querySelectorAll('#comments, .comments, .comment-section, #respond, .respond, .reply');
      commentAreas.forEach(area => {
        const form = area.closest('form');
        if (form) {
          commentForms.add(form);
        }
      });
    }

    if (commentForms.size > 0) {
      commentForms.forEach((form) => {
        const formInputs = Array.from(form.querySelectorAll('input'));

        const nameInput = formInputs.find((input) => {
          const type = (input.type || '').toLowerCase();
          if (type === 'email' || type === 'password' || type === 'checkbox' || type === 'radio') {
            return false;
          }
          const name = (input.name || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          const text = `${name} ${id} ${placeholder}`;
          const keywords = [
            'name',
            'your-name',
            'author',
            'nickname',
            'nick',
            'fullname',
            'full-name',
            'display-name',
            'contact',
            '联系人',
            '姓名',
            '名字',
            '称呼',
            'nombre'
          ];
          return keywords.some((k) => text.includes(k));
        });
        if (nameInput) {
          setValue(nameInput, USERNAME);
        }

        const emailInputInForm = formInputs.find((input) => {
          const type = (input.type || '').toLowerCase();
          const name = (input.name || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();

          if (type === 'hidden' || type === 'password' || type === 'checkbox' || type === 'radio') {
            return false;
          }

          if (type === 'email') return true;

          const text = `${name} ${id} ${placeholder}`;
          const keywords = ['email', 'e-mail', 'mail'];
          return keywords.some((k) => text.includes(k));
        });
        if (emailInputInForm) {
          setValue(emailInputInForm, EMAIL);
        }

        const websiteInput = formInputs.find((input) => {
          const type = (input.type || '').toLowerCase();
          if (type === 'email' || type === 'password' || type === 'checkbox' || type === 'radio') {
            return false;
          }
          const name = (input.name || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          const text = `${name} ${id} ${placeholder}`;
          const keywords = [
            'website',
            'site',
            'homepage',
            'home-page',
            'blog',
            'url',
            'link',
            'web',
            '网站',
            '网址',
            '站点'
          ];
          return keywords.some((k) => text.includes(k));
        });
        if (websiteInput && WEBSITE) {
          setValue(websiteInput, WEBSITE);
        }
      });
    }
  }

  function setValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'value'
    );
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    // 标准 input / change 事件（覆盖大多数场景）
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    // React 16+ / Vue 需要 InputEvent 并带 inputType
    try {
      const inputEvent = new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value
      });
      input.dispatchEvent(inputEvent);
    } catch (_) {}

    // 某些主题在 blur 时才触发验证（如 Akismet、WP Math Latex 等插件）
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true, relatedTarget: null }));
  }

  // ──────────────────────────────────────────────────────────────
  //  处理 contenteditable div（如 wpDiscuz 评论框）
  // ──────────────────────────────────────────────────────────────
  function setValueForEditableDiv(div, value) {
    if (!div || div.getAttribute('contenteditable') !== 'true') return;
    
    console.log('[AutoComment] 填充 wpDiscuz 编辑器');
    
    // 先清空内容
    div.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    
    // 设置新内容
    div.textContent = value;
    
    // 触发输入事件
    div.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    div.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    
    // 尝试触发 keydown/keyup 事件
    try {
      div.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }));
      div.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
    } catch (_) {}
    
    // 触发 blur
    div.dispatchEvent(new FocusEvent('blur', { bubbles: true, relatedTarget: null }));
    
    console.log('[AutoComment] wpDiscuz 编辑器填充完成，长度:', value.length);
  }

  // ──────────────────────────────────────────────────────────────
  //  强化版填值：先聚焦 → 清空 → 按字符填入 → 触发完整事件链
  //  适用于 WordPress 中使用 React/Vue 或字符级监听的主题
  // ──────────────────────────────────────────────────────────────
  function setValueRobust(input, value) {
    console.log('进入setValueRobust方法');
    try {
      input.focus();
      input.select && input.select();
    } catch (_) {}

    // 模拟逐字输入（最高兼容性）
    console.log('开始模拟逐字输入');
    for (const ch of value) {
      if (input.value && input.value.length > 0) {
        // 用 setValue 方法清空已有内容
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
        if (desc && desc.set) {
          desc.set.call(input, '');
        } else {
          input.value = '';
        }
      }
      const prevVal = input.value;
      // 追加字符
      const desc2 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      if (desc2 && desc2.set) {
        desc2.set.call(input, prevVal + ch);
      } else {
        input.value = prevVal + ch;
      }
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }

    // 再触发一次完整赋值 + 事件
    console.log('再触发一次完整赋值 + 事件');
    const desc3 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    if (desc3 && desc3.set) {
      desc3.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: value
      }));
    } catch (_) {}
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true, relatedTarget: null }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ====== AI 生成配置 ======
  const WEBSITE_URL_STORAGE_KEY = 'promotion_website_url';
  const WEBSITE_CONTENT_STORAGE_KEY = 'promotion_website_content';
  const USER_NAME_STORAGE_KEY = 'auto_fill_user_name';
  const USER_EMAIL_STORAGE_KEY = 'auto_fill_user_email';
  const PROMPT_FIELD_VALUES_STORAGE_KEY = 'auto_fill_prompt_field_values';
  const SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY = 'show_export_outlinks_floating_button';

  // ====== 批量任务设置（从 storage.local 读取）======
  const BATCH_SETTINGS_KEY = 'batch_task_settings';
  const BATCH_URLS_KEY = 'batch_task_urls';

  // ====== 防重复生成配置 ======
  const DOMAIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const GENERATION_RECORD_KEY = 'qwen_generation_records';
  const SUBMIT_COOLDOWN_MS = 5 * 60 * 1000;
  const SUBMIT_COOLDOWN_KEY = 'qwen_submit_cooldown';

  // 从URL中提取域名（用于冷却判断）
  function extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (e) {
      const match = url.match(/^https?:\/\/([^/]+)/);
      return match ? match[1] : url;
    }
  }

  function getCurrentDomain() {
    return extractDomain(window.location.href);
  }

  function getGenerationCacheKey() {
    const taskKey =
      globalThis.AutoCommentBatchTaskConfig?.cacheKey?.();
    return taskKey ? `batch:${taskKey}` : getCurrentDomain();
  }

  // 最近一次 AI 生成的推广文案（用于页面自动填充 & 浮动窗口回显）
  let lastGeneratedPromotionCopy = '';

  function buildQwenSkillTemplate(promotionWebsiteUrl, promotionWebsiteContent) {
    const targetWebsiteUrl = promotionWebsiteUrl || '未配置网站链接';
    const targetWebsiteContent = promotionWebsiteContent || '未配置网站内容';

    return [
      '你是一个合规的网站营销与评论文案助手，为网站撰写自然、真实的评论文案。',
      '请根据我提供的"当前网站内容"进行分析和创作',
      '',
      '【我的网站信息】',
      `网站链接：${targetWebsiteUrl}`,
      `网站内容：${targetWebsiteContent}`,
      '',
      '',
      '【输出要求】',
      '1. 我需要在当前网站发表评论，评论需要自然关联到上面的"我的网站信息"，并吸引用户访问我的网站。',
      '2. 语气可以专业但要自然、真实。',
      '3. 使用当前网站内容的主要语言作为输出语言，尽量不要使用中文，字数建议控制在 100 词左右。',
      '4. 直接给出推广文案，不要有多余的输出；只输出最终评论内容，不要输出标题、字段名、解释说明或多余格式；',
      '5.【链接格式要求】',
      'If you output any HTML link, the href attribute value MUST contain a real line break immediately before the closing double quote.',
      'Correct example:',
      '<a href="https://example.com/',
      '">点击这里</a>',
      'Wrong examples:',
      '<a href="https://example.com/">点击这里</a>',
      '<a href="https://example.com/\\n">点击这里</a>',
      'The required line break must be an actual newline character in the output, not the two characters \\ and n.'
    ].join('\n');
  }

  async function getQwenSkillTemplate() {
    const [promotionWebsiteUrl, promotionWebsiteContent] = await Promise.all([
      getWebsiteUrl(),
      getWebsiteContent()
    ]);
    return buildQwenSkillTemplate(promotionWebsiteUrl, promotionWebsiteContent);
  }

  function pickLegacyPromptValue(values, keywords) {
    if (!values || typeof values !== 'object') return '';
    const normalizedKeywords = keywords.map((keyword) => String(keyword).toLowerCase());
    const entry = Object.entries(values).find(([key, value]) => {
      if (!value) return false;
      const normalizedKey = String(key || '').toLowerCase();
      return normalizedKeywords.some((keyword) => normalizedKey.includes(keyword));
    });
    return entry ? String(entry[1] || '').trim() : '';
  }

  let manualDefaultTaskConfigPromise = null;

  function getManualDefaultTaskConfig() {
    if (!manualDefaultTaskConfigPromise) {
      manualDefaultTaskConfigPromise =
        globalThis.AutoCommentBatchTaskConfig.loadManualDefault({
          async getConfig() {
            const response = await chrome.runtime.sendMessage({
              type: 'BATCH_GET_MANUAL_DEFAULT_CONFIG'
            });
            if (!response?.ok) {
              throw new Error(
                response?.error || 'manual_default_config_unavailable'
              );
            }
            return response.config;
          }
        });
    }
    return manualDefaultTaskConfigPromise;
  }

  // 从 chrome.storage.sync 中异步获取推广网站地址
  function getWebsiteUrl() {
    const taskConfig = globalThis.AutoCommentBatchTaskConfig?.getCurrent?.();
    if (taskConfig) {
      return Promise.resolve(taskConfig.promotionSite.url);
    }
    return getManualDefaultTaskConfig()
      .then((manual) => manual.promotionSite.url)
      .catch(() => new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
        resolve('');
        return;
      }
      chrome.storage.sync.get([WEBSITE_URL_STORAGE_KEY, PROMPT_FIELD_VALUES_STORAGE_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          console.error('读取推广网站地址失败：', chrome.runtime.lastError);
          resolve('');
          return;
        }
        const savedUrl = result && typeof result[WEBSITE_URL_STORAGE_KEY] === 'string'
          ? result[WEBSITE_URL_STORAGE_KEY].trim()
          : '';
        const legacyUrl = pickLegacyPromptValue(result && result[PROMPT_FIELD_VALUES_STORAGE_KEY], [
          '网站链接',
          '网址',
          'website link',
          'website url',
          'url'
        ]);
        resolve(savedUrl || legacyUrl);
      });
      }));
  }

  function getWebsiteContent() {
    const taskConfig = globalThis.AutoCommentBatchTaskConfig?.getCurrent?.();
    if (taskConfig) {
      return Promise.resolve(taskConfig.promotionSite.content);
    }
    return getManualDefaultTaskConfig()
      .then((manual) => manual.promotionSite.content)
      .catch(() => new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
        resolve('');
        return;
      }
      chrome.storage.sync.get([WEBSITE_CONTENT_STORAGE_KEY, PROMPT_FIELD_VALUES_STORAGE_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          console.error('读取推广网站内容失败：', chrome.runtime.lastError);
          resolve('');
          return;
        }
        const savedContent = result && typeof result[WEBSITE_CONTENT_STORAGE_KEY] === 'string'
          ? result[WEBSITE_CONTENT_STORAGE_KEY].trim()
          : '';
        const legacyContent = pickLegacyPromptValue(result && result[PROMPT_FIELD_VALUES_STORAGE_KEY], [
          '网站内容',
          '网站介绍',
          'website content',
          'site content',
          'description'
        ]);
        resolve(savedContent || legacyContent);
      });
      }));
  }

  // 从 chrome.storage.sync 中异步获取用户的姓名 / 邮箱 / 密码
  async function getUserProfile({ includePassword = false } = {}) {
    const taskConfig = globalThis.AutoCommentBatchTaskConfig?.getCurrent?.();
    if (taskConfig) {
      const password = includePassword
        ? await globalThis.AutoCommentBatchTaskConfig.getTaskPassword(
            chrome.runtime
          )
        : '';
      return {
        name: taskConfig.profile.name,
        email: taskConfig.profile.email,
        password: password || ''
      };
    }
    try {
      const manual = await getManualDefaultTaskConfig();
      return {
        name: manual.profile.name,
        email: manual.profile.email,
        password: DEFAULT_PASSWORD
      };
    } catch (_) {}
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
        resolve({ name: DEFAULT_USERNAME, email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD });
        return;
      }
      chrome.storage.sync.get(
        [USER_NAME_STORAGE_KEY, USER_EMAIL_STORAGE_KEY],
        (result) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            console.error('读取用户姓名/邮箱/密码失败：', chrome.runtime.lastError);
            resolve({ name: DEFAULT_USERNAME, email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD });
            return;
          }
          let name = result && typeof result[USER_NAME_STORAGE_KEY] === 'string'
            ? result[USER_NAME_STORAGE_KEY].trim() : '';
          let email = result && typeof result[USER_EMAIL_STORAGE_KEY] === 'string'
            ? result[USER_EMAIL_STORAGE_KEY].trim() : '';
          if (!name) name = DEFAULT_USERNAME;
          if (!email) email = DEFAULT_EMAIL;

          resolve({ name, email, password: DEFAULT_PASSWORD });
        }
      );
    });
  }

  function getShowExportOutlinksFloatingButtonSetting() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
        resolve(true);
        return;
      }
      chrome.storage.sync.get([SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          console.error('读取导出外链浮动按钮设置失败：', chrome.runtime.lastError);
          resolve(true);
          return;
        }
        resolve(!result || result[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY] !== false);
      });
    });
  }

  // 从 chrome.storage.local 中获取"是否自动打开浮动窗口"的设置
  // 仅当当前 URL 在批量任务列表中时才返回 true
  function getAutoOpenQwenPanelSetting() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(false);
        return;
      }
      // 同时读取设置和 URL 列表
      chrome.storage.local.get([BATCH_SETTINGS_KEY, BATCH_URLS_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        const settings = result[BATCH_SETTINGS_KEY];
        const urls = result[BATCH_URLS_KEY];
        if (!settings || !urls || !Array.isArray(urls)) {
          resolve(false);
          return;
        }
        // 验证当前 URL 是否在批量任务列表中
        const currentUrl = window.location.href;
        const isInBatch = urls.some(url => currentUrl.startsWith(url) || url.startsWith(currentUrl));
        if (!isInBatch) {
          resolve(false);
          return;
        }
        resolve(Boolean(settings.autoOpenPanel));
      });
    });
  }

  // 从 chrome.storage.local 中获取"是否在页面加载时自动调用 AI 生成"的设置
  // 仅当当前 URL 在批量任务列表中时才返回 true
  function getAutoGenerateQwenOnPageLoadSetting() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(false);
        return;
      }
      chrome.storage.local.get([BATCH_SETTINGS_KEY, BATCH_URLS_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        const settings = result[BATCH_SETTINGS_KEY];
        const urls = result[BATCH_URLS_KEY];
        if (!settings || !urls || !Array.isArray(urls)) {
          resolve(false);
          return;
        }
        const currentUrl = window.location.href;
        const isInBatch = urls.some(url => currentUrl.startsWith(url) || url.startsWith(currentUrl));
        if (!isInBatch) {
          resolve(false);
          return;
        }
        resolve(Boolean(settings.autoGenerate));
      });
    });
  }

  // 从 chrome.storage.local 中获取"是否自动提交评论"的设置
  // 仅当当前 URL 在批量任务列表中时才返回 true
  function getAutoSubmitCommentSetting() {
    return new Promise((resolve) => {
      console.log('[AutoComment] getAutoSubmitCommentSetting 开始检查...');

      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        console.log('[AutoComment] chrome 或 chrome.storage.local 未定义，返回 false');
        resolve(false);
        return;
      }

      chrome.storage.local.get([BATCH_SETTINGS_KEY, BATCH_URLS_KEY], (result) => {
        console.log('[AutoComment] storage.local.get 回调，result:', JSON.stringify(result));
        if (chrome.runtime && chrome.runtime.lastError) {
          console.log('[AutoComment] chrome.runtime.lastError 存在，返回 false');
          resolve(false);
          return;
        }
        const settings = result[BATCH_SETTINGS_KEY];
        const urls = result[BATCH_URLS_KEY];
        console.log('[AutoComment] settings:', settings, 'urls:', urls);
        if (!settings || !urls || !Array.isArray(urls)) {
          console.log('[AutoComment] 设置或 URL 列表无效，返回 false');
          resolve(false);
          return;
        }
        // 验证当前 URL 是否在批量任务列表中
        const currentUrl = window.location.href;
        const isInBatch = urls.some(url => currentUrl.startsWith(url) || url.startsWith(currentUrl));
        console.log('[AutoComment] currentUrl:', currentUrl, 'isInBatch:', isInBatch);
        if (!isInBatch) {
          console.log('[AutoComment] 当前 URL 不在批量任务列表中，返回 false');
          resolve(false);
          return;
        }
        const val = Boolean(settings.autoSubmit);
        console.log('[AutoComment] 开关值:', val);
        resolve(val);
      });
    });
  }

  // 检查当前域名是否在冷却时间内
  function isUrlInCooldown() {
    return new Promise((resolve) => {
      const currentDomain = getCurrentDomain();

      if (typeof chrome === 'undefined' || !chrome.storage) {
        resolve(false);
        return;
      }

      let storageArea = null;
      try {
        if (chrome.storage.local && typeof chrome.storage.local.get === 'function') {
          storageArea = chrome.storage.local;
        }
      } catch (_e) {
        resolve(false);
        return;
      }

      if (!storageArea) {
        resolve(false);
        return;
      }

      storageArea.get([GENERATION_RECORD_KEY, SUBMIT_COOLDOWN_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(false);
          return;
        }

        const records = result && result[GENERATION_RECORD_KEY];
        const submitCooldown = result && result[SUBMIT_COOLDOWN_KEY];

        if (submitCooldown && submitCooldown.domain === currentDomain) {
          const submitTime = submitCooldown.timestamp || 0;
          const timeSinceSubmit = Date.now() - submitTime;
          if (timeSinceSubmit < SUBMIT_COOLDOWN_MS) {
            resolve(true);
            return;
          }
        }

        if (records && records[currentDomain] && records[currentDomain].timestamp) {
          const lastGenTime = records[currentDomain].timestamp;
          const timeSinceGen = Date.now() - lastGenTime;
          if (timeSinceGen < DOMAIN_COOLDOWN_MS) {
            resolve(true);
            return;
          }
        }

        resolve(false);
      });
    });
  }

  // 记录当前域名的生成时间戳和内容
  function recordGenerationTime(content) {
    return new Promise((resolve) => {
      const currentDomain = getGenerationCacheKey();

      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }

      chrome.storage.local.get([GENERATION_RECORD_KEY], (result) => {
        const records = result && result[GENERATION_RECORD_KEY] || {};
        records[currentDomain] = {
          timestamp: Date.now(),
          content: content || ''
        };

        // 清理过期的记录（只保留7天内的）
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const domain in records) {
          if (records[domain] && records[domain].timestamp < sevenDaysAgo) {
            delete records[domain];
          }
        }

        chrome.storage.local.set({ [GENERATION_RECORD_KEY]: records }, () => {
          resolve();
        });
      });
    });
  }

  // 记录表单提交事件
  function recordFormSubmit() {
    return new Promise((resolve) => {
      const currentDomain = getCurrentDomain();

      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }

      chrome.storage.local.set({
        [SUBMIT_COOLDOWN_KEY]: {
          domain: currentDomain,
          timestamp: Date.now()
        }
      }, () => {
        resolve();
      });
    });
  }

  // 获取缓存的推广文案
  function getCachedPromotionCopy() {
    return new Promise((resolve) => {
      const currentDomain = getGenerationCacheKey();

      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve('');
        return;
      }

      chrome.storage.local.get([GENERATION_RECORD_KEY], (result) => {
        const records = result && result[GENERATION_RECORD_KEY];
        if (records && records[currentDomain] && records[currentDomain].content) {
          resolve(records[currentDomain].content);
        } else {
          resolve('');
        }
      });
    });
  }

  // 监听表单提交事件
  function setupFormSubmitListener() {
    document.addEventListener('submit', (event) => {
      const form = event.target;
      const isCommentForm = form && (
        form.id?.toLowerCase().includes('comment') ||
        form.className?.toLowerCase().includes('comment') ||
        form.method?.toLowerCase() === 'post'
      );

      if (isCommentForm) {
        setTimeout(() => {
          recordFormSubmit();
        }, 1500);
      }
    }, { capture: true });
  }

  // 在页面打开时自动调用一次 AI 生成
  let autoGeneratedOnce = false;

  // 批处理模式上下文（由 BATCH_HANDLE 消息注入）
  let _batchCtx = null;
  let runningBatchTaskKey = null;
  let historyRevisionSequence = 0;

  function setBatchContext(taskConfig) {
    _batchCtx = taskConfig;
  }

  function getBatchTaskKey(batchIdOrContext, urlIndex, attempt, taskContext) {
    const context = (
      batchIdOrContext &&
      typeof batchIdOrContext === 'object'
    ) ? batchIdOrContext : taskContext || {
      batchId: batchIdOrContext,
      taskId: `${batchIdOrContext}:legacy:${urlIndex}`,
      promotionSiteId: 'default-promotion-site',
      attempt
    };
    return [
      context.batchId,
      context.taskId,
      context.promotionSiteId,
      context.attempt
    ].join(':');
  }

  function getBatchHandleValidationError(message) {
    if (!Number.isInteger(message?.attempt)) {
      return {
        ok: false,
        error: 'invalid_batch_attempt',
        urlIndex: message?.urlIndex
      };
    }
    try {
      const taskConfig =
        globalThis.AutoCommentBatchTaskConfig?.acceptHandle?.(message);
      if (!taskConfig) throw new Error('batch_task_config_unavailable');
      return { taskConfig };
    } catch (error) {
      return {
        ok: false,
        error: error?.code || 'invalid_task_config',
        urlIndex: message?.urlIndex
      };
    }
  }

  const batchHandleDispatcher =
    globalThis.AutoCommentBatchHandleDispatch?.create?.({
      accept: getBatchHandleValidationError,
      getKey: getBatchTaskKey,
      execute(taskConfig) {
        setBatchContext(taskConfig);
        return handleBatchTask(
          taskConfig.batchId,
          taskConfig.urlIndex,
          taskConfig.attempt,
          taskConfig.url
        );
      },
      onExecutionError(error, taskConfig) {
        console.error('[content] BATCH_HANDLE 异步处理异常', {
          batchId: taskConfig?.batchId,
          urlIndex: taskConfig?.urlIndex,
          errorCode: typeof error?.code === 'string'
            ? error.code
            : 'batch_task_failed'
        });
      }
    });

  async function reportBatchPhase(context, phase) {
    const reporter = globalThis.AutoCommentBatchPhaseReporter;
    if (!reporter?.report) throw new Error('batch_phase_reporter_unavailable');
    const response = await reporter.report(chrome.runtime, context, phase);
    if (!response?.ok) {
      throw new Error(response?.error || 'batch_phase_write_failed');
    }
  }

  function reportBatchDiagnostic(context, event, details = {}) {
    const reporter = globalThis.AutoCommentBatchPhaseReporter;
    if (!reporter?.reportDiagnostic) return Promise.resolve(null);
    return reporter.reportDiagnostic(
      chrome.runtime,
      context,
      event,
      details
    ).catch(() => null);
  }
  globalThis.AutoCommentReportBatchDiagnostic = reportBatchDiagnostic;

  function createHistoryUniqueId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    historyRevisionSequence += 1;
    return [
      Date.now().toString(36),
      historyRevisionSequence.toString(36),
      Math.random().toString(36).slice(2)
    ].join('-');
  }

  function hasCompleteBatchResultIdentity(batchId, urlIndex, attempt) {
    return (
      typeof batchId === 'string'
      && batchId.length > 0
      && Number.isInteger(urlIndex)
      && urlIndex >= 0
      && Number.isInteger(attempt)
      && attempt >= 1
    );
  }

  function hasHistoryRevision(history) {
    const revision = history?.historyRevision;
    return Boolean(
      revision
      && Number.isFinite(revision.capturedAt)
      && Number.isFinite(revision.recordedAt)
      && Number.isInteger(revision.sequence)
      && revision.sequence >= 0
      && typeof revision.id === 'string'
      && revision.id
    );
  }

  function ensureHistoryRevision(history) {
    if (!history || hasHistoryRevision(history)) return history;
    const capturedAt = Number.isFinite(history.submittedAt)
      ? history.submittedAt
      : Date.now();
    historyRevisionSequence += 1;
    return {
      ...history,
      historyRevision: {
        capturedAt,
        recordedAt: Date.now(),
        sequence: historyRevisionSequence,
        id: createHistoryUniqueId()
      }
    };
  }

  async function captureCurrentCommentHistory(editor, pageUrl) {
    const promotedWebsiteUrl = await getWebsiteUrl();
    const history = globalThis.AutoCommentHistoryCapture.captureSubmission({
      editor,
      pageUrl: pageUrl || location.href,
      promotedWebsiteUrl,
      now: Date.now()
    });
    return ensureHistoryRevision(history);
  }

  async function persistBatchSubmitContext(batchId, urlIndex, attempt, url, result, aiContent, errorMessage, history) {
    if (!window.AutoCommentBatchSubmitContext?.save) {
      throw new Error('无法在提交前保存评论历史上下文');
    }
    const identity = (
      typeof _batchCtx !== 'undefined'
      && _batchCtx
      && _batchCtx.batchId === batchId
      && _batchCtx.urlIndex === urlIndex
      && _batchCtx.attempt === attempt
    ) ? {
      batchId,
      taskId: _batchCtx.taskId,
      urlIndex,
      profileId: _batchCtx.profileId,
      promotionSiteId: _batchCtx.promotionSiteId,
      attempt
    } : { batchId, urlIndex, attempt };
    await window.AutoCommentBatchSubmitContext.save({
      ...identity,
      url,
      result,
      aiContent: aiContent || null,
      errorMessage: errorMessage || null,
      history
    });
  }

  async function markBatchTaskSubmitting(batchId, urlIndex, attempt) {
    try {
      const identity = (
        typeof _batchCtx !== 'undefined'
        && _batchCtx
        && _batchCtx.batchId === batchId
        && _batchCtx.urlIndex === urlIndex
        && _batchCtx.attempt === attempt
      ) ? {
        batchId,
        taskId: _batchCtx.taskId,
        urlIndex,
        profileId: _batchCtx.profileId,
        promotionSiteId: _batchCtx.promotionSiteId,
        attempt
      } : { batchId, urlIndex, attempt };
      const response = await chrome.runtime.sendMessage({
        type: 'BATCH_TASK_SUBMITTING',
        ...identity
      });
      if (!response?.ok) {
        throw new Error(response?.error || '无法保存批处理提交阶段');
      }
    } catch (error) {
      await clearBatchSubmitContext({ batchId, urlIndex, attempt });
      throw error;
    }
  }

  function clearBatchSubmitContext(match) {
    const identity = (
      typeof _batchCtx !== 'undefined'
      && _batchCtx
      && match?.batchId === _batchCtx.batchId
      && match?.urlIndex === _batchCtx.urlIndex
      && match?.attempt === _batchCtx.attempt
    ) ? {
      ...match,
      taskId: _batchCtx.taskId,
      profileId: _batchCtx.profileId,
      promotionSiteId: _batchCtx.promotionSiteId
    } : match;
    return Promise.resolve(
      window.AutoCommentBatchSubmitContext?.clear?.(identity)
    )
      .catch(() => {});
  }

  const BATCH_PROVEN_MESSAGE_MAX_ATTEMPTS = 2;
  const BATCH_AUTHORIZATION_TERMINAL_ERRORS = new Set([
    'stale_worker_tab',
    'stale_attempt',
    'checkpoint_not_found',
    'task_already_terminal',
    'stale_batch',
    'stale_task_assignment',
    'invalid_task_identity',
    'invalid_url_index',
    'forbidden_sender'
  ]);
  const BATCH_RETRYABLE_OWNERSHIP_ERRORS = new Set([
    'batch_teardown_cleanup_failed',
    'batch_ownership_unverified',
    'checkpoint_write_failed',
    'submit_context_not_released'
  ]);

  function isAuthorizationTerminalBatchError(error) {
    return BATCH_AUTHORIZATION_TERMINAL_ERRORS.has(error);
  }

  function isRetryableBatchOwnershipError(error) {
    return BATCH_RETRYABLE_OWNERSHIP_ERRORS.has(error);
  }

  async function sendProvenBatchMessage(message) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return {
        response: null,
        transportExhausted: true
      };
    }
    for (
      let attempt = 1;
      attempt <= BATCH_PROVEN_MESSAGE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      let response;
      try {
        const outbound = (
          typeof _batchCtx !== 'undefined'
          && _batchCtx
          && message?.batchId === _batchCtx.batchId
          && message?.urlIndex === _batchCtx.urlIndex
          && message?.attempt === _batchCtx.attempt
        ) ? {
          ...message,
          taskId: _batchCtx.taskId,
          profileId: _batchCtx.profileId,
          promotionSiteId: _batchCtx.promotionSiteId
        } : message;
        response = await chrome.runtime.sendMessage(outbound);
      } catch (_) {
        if (attempt === BATCH_PROVEN_MESSAGE_MAX_ATTEMPTS) {
          return {
            response: null,
            transportExhausted: true
          };
        }
        continue;
      }
      if (response?.ok === true) {
        return { response, transportExhausted: false };
      }
      if (isAuthorizationTerminalBatchError(response?.error)) {
        return {
          response,
          authorizationTerminal: true,
          transportExhausted: false
        };
      }
      if (
        isRetryableBatchOwnershipError(response?.error) &&
        attempt < BATCH_PROVEN_MESSAGE_MAX_ATTEMPTS
      ) {
        continue;
      }
      return { response, transportExhausted: false };
    }
    return {
      response: null,
      transportExhausted: true
    };
  }

  function isAcknowledgedBatchHistoryConfirmation(message, response) {
    if (!response?.ok) return false;
    if (
      response.historySaveStatus === 'saved'
      || response.historySaveStatus === 'queued'
    ) {
      return true;
    }
    if (response.historySaveStatus !== 'not_applicable') return false;
    const result = message?.result ?? 'success';
    return result !== 'success' || (
      !message?.history
      && message?.historyUnavailableReason === 'legacy_context'
    );
  }

  async function confirmBatchHistoryDurably(message) {
    const versionedMessage = message?.history
      ? {
          ...message,
          history: ensureHistoryRevision(message.history)
        }
      : message;
    const primary = await sendProvenBatchMessage(versionedMessage);
    const acknowledgement = primary.response;
    const backgroundAcknowledged = isAcknowledgedBatchHistoryConfirmation(
      versionedMessage,
      acknowledgement
    );
    if (backgroundAcknowledged) {
      return { durable: true, acknowledgement };
    }
    if (
      primary.transportExhausted ||
      primary.authorizationTerminal ||
      acknowledgement?.historySaveStatus !== 'failed'
    ) {
      return { durable: false, acknowledgement };
    }
    const fallback = await sendProvenBatchMessage({
      ...versionedMessage,
      type: 'BATCH_HISTORY_PENDING_FALLBACK'
    });
    return {
      durable: isAcknowledgedBatchHistoryConfirmation(
        versionedMessage,
        fallback.response
      ),
      acknowledgement
    };
  }

  function restoredContextDiagnostic(ctx) {
    return {
      batchId: ctx?.batchId,
      taskId: ctx?.taskId,
      urlIndex: ctx?.urlIndex,
      attempt: ctx?.attempt,
      profileId: ctx?.profileId,
      promotionSiteId: ctx?.promotionSiteId,
      hasHistory: Boolean(ctx?.history),
      aiContentLength: typeof ctx?.aiContent === 'string'
        ? ctx.aiContent.length
        : 0
    };
  }

  function getNavigationResponseStatus() {
    try {
      const entry = performance.getEntriesByType('navigation')[0];
      const status = Number(entry?.responseStatus);
      return Number.isFinite(status) ? status : 0;
    } catch (_) {
      return 0;
    }
  }

  function getSubmissionSignalText(selectors) {
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_) {}
      for (const node of nodes) {
        const text = String(
          node?.innerText || node?.textContent || ''
        ).replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    }
    return '';
  }

  function normalizeSubmissionComparisonText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  function hasRenderedSubmittedComment(expectedCommentText) {
    const expected = normalizeSubmissionComparisonText(expectedCommentText);
    if (expected.length < 8) return false;
    const selectors = [
      '#comments [id^="comment-"] .comment-content',
      '#comments [id^="comment-"] .comment-body',
      '#comments [id^="comment-"]',
      '.comment-list .comment-content',
      '.comment-list .comment-body',
      '.comment-list li.comment',
      '.comments-area article.comment',
      '.comments-area li.comment',
      '.wpd-comment-text',
      '[data-comment-id]'
    ];
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_) {}
      for (const node of nodes) {
        if (node?.closest?.('form')) continue;
        const candidate = normalizeSubmissionComparisonText(
          node?.innerText || node?.textContent
        );
        if (candidate && candidate.includes(expected)) return true;
      }
    }
    return false;
  }

  function expectedSubmittedCommentText(ctx) {
    const captured = String(ctx?.history?.commentText || '').trim();
    if (captured) return captured;
    const fallback = String(ctx?.aiContent || '').trim();
    if (!fallback) return '';
    try {
      const template = document.createElement('template');
      template.innerHTML = fallback;
      return template.content.textContent || fallback;
    } catch (_) {
      return fallback.replace(/<[^>]*>/g, ' ');
    }
  }

  function inspectSubmissionDocument({
    allowClearedTextarea = false,
    expectedCommentText = ''
  } = {}) {
    const challenge = detectManualRequiredChallenge();
    if (challenge.found) {
      return {
        status: 'uncertain',
        reason: challenge.message || MANUAL_REQUIRED_MESSAGE
      };
    }

    const errorText = getSubmissionSignalText([
      '#error-page .wp-die-message',
      '.wp-die-message',
      '#commentform [role="alert"]',
      '#respond [role="alert"]',
      '.comment-form [role="alert"]',
      '.comment-error',
      '.comment-form-error',
      '[data-comment-error]',
      '.wpcf7-not-valid-tip',
      '.wpcf7-response-output.wpcf7-validation-errors',
      '.wpcf7-response-output.wpcf7-mail-sent-ng'
    ]);
    if (errorText) {
      return {
        status: 'rejected',
        reason: `目标页面返回提交错误：${errorText.slice(0, 240)}`
      };
    }

    const successText = getSubmissionSignalText([
      '#comment-awaiting-moderation',
      '.comment-awaiting-moderation',
      '.comment-success',
      '.comment-submitted',
      '[data-comment-status="success"]',
      '#submit-result'
    ]);
    if (successText) {
      return {
        status: 'success',
        reason: successText.slice(0, 240)
      };
    }

    if (/^#comment(?:-\d+)?$/i.test(location.hash || '')) {
      return { status: 'success', reason: '已导航到新评论锚点' };
    }

    if (hasRenderedSubmittedComment(expectedCommentText)) {
      return {
        status: 'success',
        reason: '刷新后已在评论列表中找到本次评论'
      };
    }

    const responseStatus = getNavigationResponseStatus();
    if (responseStatus >= 400) {
      return {
        status: 'rejected',
        reason: `提交页面返回 HTTP ${responseStatus}`
      };
    }

    if (allowClearedTextarea) {
      const textarea = findLikelyCommentTextarea({
        allowGenericFallback: true
      });
      if (textarea && !String(textarea.value || '').trim()) {
        return { status: 'success', reason: '请求完成且评论框已清空' };
      }
    }

    return {
      status: 'uncertain',
      reason: '未检测到服务器确认或明确的提交成功状态'
    };
  }

  function inspectRestoredSubmissionDocument(ctx) {
    const inspected = inspectSubmissionDocument({
      expectedCommentText: expectedSubmittedCommentText(ctx)
    });
    if (inspected.status !== 'uncertain') return inspected;

    const pathname = String(location.pathname || '').toLowerCase();
    if (
      /(?:wp-comments-post\.php|comment-submit|comments?\/(?:post|submit|reply))/
        .test(pathname)
    ) {
      return {
        status: 'uncertain',
        reason: '提交后停留在评论接收页面，未确认服务器已接受评论'
      };
    }

    return {
      status: 'uncertain',
      reason: '页面已刷新，但未找到本次评论、审核提示或明确错误'
    };
  }

  async function confirmRestoredBatchSubmit(ctx) {
    if (!hasCompleteBatchResultIdentity(
      ctx?.batchId,
      ctx?.urlIndex,
      ctx?.attempt
    )) return;
    console.log(
      '[AutoComment] 恢复提交后上下文，仅补发确认，不重新生成AI:',
      restoredContextDiagnostic(ctx)
    );
    const outcome = inspectRestoredSubmissionDocument(ctx);
    const confirmedSuccess = outcome.status === 'success';
    const confirmedFailure = outcome.status === 'rejected';
    globalThis.AutoCommentReportBatchDiagnostic?.(
      ctx,
      'submission_restored_confirmation',
      {
      confirmed: confirmedSuccess,
      confirmationStatus: outcome.status
      }
    );
    console.log('[AutoComment] 恢复页面提交结果:', {
      status: outcome.status
    });
    const message = {
      type: 'BATCH_HANDLE_CONFIRM',
      batchId: ctx.batchId,
      taskId: ctx.taskId,
      urlIndex: ctx.urlIndex,
      profileId: ctx.profileId,
      promotionSiteId: ctx.promotionSiteId,
      attempt: ctx.attempt,
      url: ctx.url || '',
      aiContent: ctx.aiContent || '',
      result: confirmedSuccess
        ? 'success'
        : confirmedFailure
          ? 'fail'
          : 'manual_required',
      errorCode: confirmedSuccess
        ? null
        : confirmedFailure
          ? 'submission_rejected'
          : 'submission_uncertain',
      errorMessage: confirmedSuccess ? null : outcome.reason,
      history: confirmedSuccess ? ctx.history : undefined,
      historyUnavailableReason: confirmedSuccess && !ctx.history
        ? 'legacy_context'
        : undefined
    };
    await confirmBatchHistoryDurably(message);
  }

  // 从 storage 恢复提交后上下文（仅补确认，不再恢复成可执行批处理任务）
  async function restoreBatchContext() {
    console.log('[AutoComment] restoreBatchContext 开始');
    let context = null;
    try {
      context = await window.AutoCommentBatchSubmitContext.restore();
    } catch (_) {}
    console.log('[AutoComment] restoreBatchContext:', {
      restored: Boolean(context)
    });
    if (context) await confirmRestoredBatchSubmit(context);
  }

  // 批处理模式专用：直接上报成功到 background
  async function reportSuccessToBatch(aiContent, history) {
    if (!_batchCtx) return;
    const { batchId, urlIndex, attempt, url } = _batchCtx;
    try {
      await writePendingResult(
        batchId,
        urlIndex,
        attempt,
        url,
        'success',
        aiContent,
        null,
        null
      );
    } catch (_) {}
    await confirmBatchHistoryDurably({
      type: 'BATCH_HANDLE_CONFIRM',
      batchId,
      urlIndex,
      attempt,
      url: url || '',
      aiContent,
      errorCode: null,
      history
    });
  }

  /**
   * 批处理模式（刷新后）：填充文案、等待页面自动刷新，刷新即确认成功
   * 与 handleBatchTask 的区别：不重新生成文案，复用 _batchCtx，复用缓存
   */
  async function handleBatchTaskForAutoMode() {
    console.log('[AutoComment] handleBatchTaskForAutoMode 开始');
    if (!_batchCtx) {
      console.log('[AutoComment] handleBatchTaskForAutoMode 跳过：_batchCtx 为空');
      return;
    }
    const { batchId, urlIndex, attempt, url } = _batchCtx;
    console.log('[AutoComment] handleBatchTaskForAutoMode 任务:', {
      batchId,
      taskId: _batchCtx.taskId,
      urlIndex,
      attempt
    });

    try {
      // 尝试获取缓存的文案或之前生成的文案
      let promotionText = await getCachedPromotionCopy() || lastGeneratedPromotionCopy;
      console.log('[AutoComment] handleBatchTaskForAutoMode cachedCopy:', !!await getCachedPromotionCopy(), 'lastGeneratedPromotionCopy:', !!lastGeneratedPromotionCopy);

      // 如果没有缓存文案，则触发评论表单流程并生成 AI 文案
      if (!promotionText) {
        console.log('[AutoComment] handleBatchTaskForAutoMode 无缓存文案，触发表单流程并生成文案...');

        // 触发评论表单展开（处理懒加载和需要滚动的情况）
        await triggerCommentFormFlow();
        // 等待表单加载
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 检查评论表单是否存在
        const form = findCommentForm();
        const ta = findLikelyCommentTextarea({ allowGenericFallback: true });

        if (!form || !ta) {
          console.log('[AutoComment] handleBatchTaskForAutoMode 评论框不存在，结束任务');
          throw new Error('__NO_COMMENT_BOX__');
        }

        const manualCheck = detectManualRequiredChallenge(form);
        if (manualCheck.found) {
          await reportManualRequiredAndClose(
            batchId,
            urlIndex,
            attempt,
            url,
            null
          );
          return;
        }

        // 生成 AI 文案
        console.log('[AutoComment] handleBatchTaskForAutoMode 生成AI文案...');
        await reportBatchPhase(_batchCtx, 'generating');
        promotionText = await generatePromotionCopyWithLlm();
        console.log('[AutoComment] handleBatchTaskForAutoMode AI文案生成成功，长度:', promotionText.length);
      }

      await reportBatchPhase(_batchCtx, 'filling');
      const filled = tryFillCommentTextareaWithPromotion(promotionText);
      console.log('[AutoComment] handleBatchTaskForAutoMode tryFillCommentTextareaWithPromotion 结果:', filled);
      if (!filled) {
        return;
      }

      await ensureAllCommentFormFieldsFilled(promotionText);

      const manualCheckBeforeSubmit = detectManualRequiredChallenge();
      if (manualCheckBeforeSubmit.found) {
        await reportManualRequiredAndClose(
          batchId,
          urlIndex,
          attempt,
          url,
          promotionText
        );
        return;
      }

      const editor = findLikelyCommentTextarea({ allowGenericFallback: true });
      const history = await captureCurrentCommentHistory(editor, url);
      await persistBatchSubmitContext(
        batchId,
        urlIndex,
        attempt,
        url,
        'success',
        promotionText,
        null,
        history
      );
      try {
        await reportBatchPhase(_batchCtx, 'submitting');
      } catch (error) {
        await clearBatchSubmitContext({ batchId, urlIndex, attempt });
        throw error;
      }
      await markBatchTaskSubmitting(batchId, urlIndex, attempt);
      const navResult = await waitForNavigate(12000);

      await reportSuccessToBatch(promotionText, history);
    } catch (err) {
      console.error('[AutoComment] handleBatchTaskForAutoMode 异常', {
        errorCode: typeof err?.code === 'string'
          ? err.code
          : 'auto_mode_failed'
      });
    }
  }

  async function autoGeneratePromotionOnPageLoad() {
    console.log('[AutoComment] autoGeneratePromotionOnPageLoad 调用开始');
    if (autoGeneratedOnce) {
      console.log('[AutoComment] autoGeneratePromotionOnPageLoad 跳过：autoGeneratedOnce=true');
      return;
    }

    console.log('[AutoComment] 页面加载自动生成已关闭；批处理仅由 BATCH_HANDLE 触发，手动生成仅由按钮触发');
  }

  // ====== 滚动触发懒加载评论 ======
  /**
   * 滚动到页面底部触发懒加载评论，然后滚动到评论区域
   */
  async function scrollToTriggerCommentLoading() {
    console.log('[AutoComment] 开始滚动触发懒加载评论...');

    // 先滚动到页面底部触发可能的懒加载
    const scrollingElement = document.scrollingElement
      || document.documentElement
      || document.body;
    if (scrollingElement) {
      window.scrollTo({
        top: Number(scrollingElement.scrollHeight) || 0,
        behavior: 'smooth'
      });
    }
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 再向上滚动到评论区域
    const commentArea = document.querySelector(
      '#comments, .comments, #respond, .respond, .comment-respond, ' +
      '.comments-area, .comment-section, #comments-section'
    );
    if (commentArea) {
      console.log('[AutoComment] 找到评论区域，滚动到该位置');
      commentArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    return !!findLikelyCommentTextarea({ allowGenericFallback: false });
  }

  // ====== 辅助函数 ======
  function isClickable(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return el.offsetParent !== null &&
           style.visibility !== 'hidden' &&
           style.display !== 'none' &&
           el.disabled !== true;
  }

  // ====== 触发评论表单展开 ======
  /**
   * 查找并点击"回复"链接来展开评论表单（WordPress 等常见用法）
   */
  async function triggerCommentFormExpansion() {
    console.log('[AutoComment] 开始尝试展开评论表单...');

    const replyLinkSelectors = [
      '.comment-reply-link',
      '.reply-link',
      'a[href*="#respond"]',
      'a[href*="#comment"]',
      'a.comment-reply',
      '.respond-link',
      'a[rel="nofollow"][href*="respond"]',
      // 英文关键词
      'a:text("Reply")',
      'a:text("Respond")',
      'a:text("Leave a reply")',
      'a:text("Re")',
      // 泰语相关
      'a:text("ตอบ")',           // ตอบ = 回复
      'a:text("แสดงความคิดเห็น")', // แสดงความคิดเห็น = 发表评论
      'a:text("ความคิดเห็น")',     // ความคิดเห็น = 评论
    ];

    // 遍历所有 a 标签，查找包含回复关键词的链接
    const allLinks = Array.from(document.querySelectorAll('a'));
    const replyLinks = [];
    const replyKeywords = ['reply', 'respond', 'leave a reply', 'leave a comment', 'write a comment', 'add comment', 're', 'ตอบ', 'แสดงความคิดเห็น', 'ความคิดเห็น'];
    
    // 只在评论区域内查找回复链接，避免误点广告
    const commentAreas = [];
    const commentAreaSelectors = [
      '#comments', '.comments', '.comment-section', '#respond', '.respond',
      '.comment-respond', '#comments-section', '.comments-area', '.comment-area',
      '.wpd-thread', '#wpd-thread', '.wpdiscuz',
      // fullcirclecinema.com 等网站使用的主评论容器
      '.post-comments', '.entry-comments', '.post-comment',
      '#post-comments', '#entry-comments',
      '.comment-wrapper', '.commentlist', '#commentlist',
      '.comments-area', '.comment_content', '.comment-body'
    ];
    for (const sel of commentAreaSelectors) {
      try {
        const areas = document.querySelectorAll(sel);
        areas.forEach(area => commentAreas.push(area));
      } catch (_) {}
    }
    
    // 收集评论区域内的所有链接
    const linksInCommentArea = new Set();
    for (const area of commentAreas) {
      const links = area.querySelectorAll('a');
      links.forEach(link => linksInCommentArea.add(link));
    }
    
    for (const link of allLinks) {
      // 如果链接不在评论区域内，跳过（避免误点广告）
      if (!linksInCommentArea.has(link)) continue;
      
      const text = (link.textContent || '').toLowerCase().trim();
      const href = (link.getAttribute('href') || '').toLowerCase();
      
      // 只匹配明确的回复链接，避免误点
      const isReplyLink = 
        replyKeywords.some(kw => text.includes(kw)) ||
        (href.includes('#respond') && !href.startsWith('http'));
      
      if (isReplyLink) {
        replyLinks.push(link);
      }
    }
    
    console.log('[AutoComment] 找到回复链接数量:', replyLinks.length);
    
    // 依次尝试点击回复链接
    for (const link of replyLinks) {
      if (!isClickable(link)) continue;
      
      console.log('[AutoComment] 点击回复链接:', link.textContent.trim());
      try {
        link.click();
        
        // 等待评论表单展开
        for (let wait = 0; wait < 3000; wait += 300) {
          await new Promise(resolve => setTimeout(resolve, 300));
          const form = findCommentForm();
          if (form) {
            console.log('[AutoComment] 评论表单已展开');
            return true;
          }
          const ta = findLikelyCommentTextarea({ allowGenericFallback: false });
          if (ta) {
            console.log('[AutoComment] 找到评论 textarea');
            return true;
          }
        }
      } catch (e) {
        console.log('[AutoComment] 点击回复链接失败', {
          errorCode: 'reply_click_failed'
        });
      }
    }

    // 尝试直接定位 #respond 并点击其中的链接
    const respondArea = document.querySelector('#respond, .respond, .comment-respond, #comment-respond, .wpdiscuz');
    if (respondArea) {
      console.log('[AutoComment] 找到评论区域');
      const innerLinks = respondArea.querySelectorAll('a');
      for (const link of innerLinks) {
        if (isClickable(link)) {
          const text = (link.textContent || '').toLowerCase();
          // 跳过社交分享链接，避免误点广告
          const skipKeywords = ['share', 'facebook', 'twitter', 'email', 'print', 'pinterest', 'linkedin', 'copy link'];
          if (skipKeywords.some(kw => text.includes(kw))) continue;
          
          try {
            console.log('[AutoComment] 点击评论区域内的链接:', link.textContent.trim());
            link.click();
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            const form = findCommentForm();
            if (form) {
              console.log('[AutoComment] 评论表单已展开');
              return true;
            }
          } catch (e) {}
        }
      }
    }

    console.log('[AutoComment] 未能展开评论表单');
    return false;
  }

  // ====== 完整触发评论流程 ======
  /**
   * 组合滚动 + 点击回复链接 + 等待表单加载
   */
  async function triggerCommentFormFlow() {
    // 步骤1: 先尝试直接找评论表单
    let form = findCommentForm();
    let ta = findLikelyCommentTextarea({ allowGenericFallback: false });

    if (form && ta) {
      console.log('[AutoComment] 直接找到评论表单，无需触发');
      return true;
    }

    // 步骤2: 滚动触发懒加载
    const scrolled = await scrollToTriggerCommentLoading();
    if (scrolled) {
      console.log('[AutoComment] 滚动后找到评论表单');
      return true;
    }

    // 步骤3: 点击回复链接展开表单
    const expanded = await triggerCommentFormExpansion();
    if (expanded) {
      console.log('[AutoComment] 点击回复链接后展开表单');
      return true;
    }

    // 步骤4: 再滚动一次并等待
    await scrollToTriggerCommentLoading();

    return !!findLikelyCommentTextarea({ allowGenericFallback: false });
  }

  async function getInitialPageMode() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'BATCH_GET_TAB_MODE'
      });
      if (response?.ok && typeof response.batchOwned === 'boolean') {
        return { batchOwned: response.batchOwned };
      }
    } catch (_) {}
    // Unknown ownership must never fall through to live manual defaults.
    return { batchOwned: true };
  }

  async function initOnPageReady() {
    console.log('[AutoComment] initOnPageReady 开始');
    // 只恢复提交后的补确认上下文；正式批处理执行只由 BATCH_HANDLE 触发。
    await restoreBatchContext();

    setupFormSubmitListener();
    applyOutlinkFloatingButtonVisibility();

    const pageMode = await getInitialPageMode();
    if (pageMode.batchOwned) return;

    observeDynamicElements();
    fillInputs();

    getAutoOpenQwenPanelSetting().then((shouldOpen) => {
      if (shouldOpen) {
        createOrToggleQwenPanel();
      }
    });

    getAutoGenerateQwenOnPageLoadSetting().then((shouldAutoGenerate) => {
      if (shouldAutoGenerate) {
        triggerCommentFormFlow().then(() => {
          autoGeneratePromotionOnPageLoad();
        });
      }
    });

  }

  let hasNotifiedCommentBox = false;
  let hasCheckedInitialCommentBox = false;
  let hasTriggeredCommentFlow = false;

  function observeDynamicElements() {
    setTimeout(() => {
      if (!hasCheckedInitialCommentBox) {
        hasCheckedInitialCommentBox = true;
        const hasCommentBox = !!findLikelyCommentTextarea({ allowGenericFallback: false });
        console.log('[AutoComment] 初始检查 hasCommentBox:', hasCommentBox, 'hasNotifiedCommentBox:', hasNotifiedCommentBox);
        if (hasCommentBox && !hasNotifiedCommentBox) {
          hasNotifiedCommentBox = true;
          getAutoGenerateQwenOnPageLoadSetting().then((shouldAutoGenerate) => {
            console.log('[AutoComment] 初始检查 shouldAutoGenerate:', shouldAutoGenerate, 'autoGeneratedOnce:', autoGeneratedOnce);
            if (shouldAutoGenerate && !autoGeneratedOnce) {
              autoGeneratePromotionOnPageLoad();
            }
          });
        }
      }
    }, 1000);

    const observer = new MutationObserver((mutations) => {
      let shouldTriggerFlow = false;

      // 检查是否有新的 textarea 或评论区域出现
      const newTextareas = document.querySelectorAll('textarea');
      if (newTextareas.length > 0 && !hasNotifiedCommentBox) {
        const hasCommentBox = !!findLikelyCommentTextarea({ allowGenericFallback: false });
        if (hasCommentBox) {
          shouldTriggerFlow = true;
          hasNotifiedCommentBox = true;
          console.log('[AutoComment] MutationObserver 检测到评论 textarea 出现');
          getAutoGenerateQwenOnPageLoadSetting().then((shouldAutoGenerate) => {
            console.log('[AutoComment] shouldAutoGenerate:', shouldAutoGenerate, 'autoGeneratedOnce:', autoGeneratedOnce);
            if (shouldAutoGenerate && !autoGeneratedOnce) {
              // 直接调用，不等待 triggerCommentFormFlow，因为 textarea 已存在
              autoGeneratePromotionOnPageLoad();
            } else {
              console.log('[AutoComment] 自动生成条件不满足，跳过');
            }
          });
        }
      }

      // 检查是否有新的回复链接被添加（增强）
      const newReplyLinks = document.querySelectorAll(
        '.comment-reply-link:not([data-auto-comment-clicked]), ' +
        '.reply-link:not([data-auto-comment-clicked]), ' +
        'a[href*="#respond"]:not([data-auto-comment-clicked])'
      );

      if (newReplyLinks.length > 0 && !hasTriggeredCommentFlow) {
        getAutoGenerateQwenOnPageLoadSetting().then((shouldAutoGenerate) => {
          if (shouldAutoGenerate && !autoGeneratedOnce && !hasTriggeredCommentFlow) {
            hasTriggeredCommentFlow = true;
            console.log('[AutoComment] MutationObserver 检测到回复链接，自动触发评论流程');

            // 标记已点击的链接，避免重复
            newReplyLinks.forEach(link => {
              link.setAttribute('data-auto-comment-clicked', 'true');
            });

            // 自动点击回复链接来展开表单
            triggerCommentFormFlow().then(() => {
              setTimeout(() => {
                autoGeneratePromotionOnPageLoad();
              }, 500);
            });
          }
        });
      }

      // 检查是否有新的评论区域出现（增强）
      const newCommentAreas = document.querySelectorAll(
        '#respond:not([data-auto-comment-checked]), ' +
        '.respond:not([data-auto-comment-checked]), ' +
        '.comment-respond:not([data-auto-comment-checked])'
      );

      newCommentAreas.forEach(area => {
        area.setAttribute('data-auto-comment-checked', 'true');
        // 检查这个区域内是否有表单或 textarea
        const hasForm = area.querySelector('form');
        const hasTextarea = area.querySelector('textarea');
        if ((hasForm || hasTextarea) && !hasNotifiedCommentBox) {
          shouldTriggerFlow = true;
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initOnPageReady();
    });
  } else {
    initOnPageReady();
  }

  function findNativeWordPressCommentForm() {
    const selectors = [
      'form#commentform',
      'form.comment-form',
      'form[name="commentform"]',
      'form[action*="wp-comments-post.php"]'
    ];

    for (const selector of selectors) {
      const form = document.querySelector(selector);
      if (form && getCommentTextareaFromForm(form)) {
        return form;
      }
    }

    return null;
  }

  function getCommentTextareaFromForm(form) {
    if (!form) return null;
    return (
      form.querySelector('textarea#comment') ||
      form.querySelector('textarea[name="comment"]') ||
      form.querySelector('textarea[id*="comment" i]') ||
      form.querySelector('textarea[name*="comment" i]') ||
      null
    );
  }

  function findLikelyCommentTextarea(options) {
    const allowGenericFallback = options && options.allowGenericFallback;
    const allTextareas = Array.from(document.querySelectorAll('textarea'));
    if (allTextareas.length === 0) return null;

    const commentTextareas = [];
    const commentForms = new Set();

    const wpNativeForm = findNativeWordPressCommentForm();
    const wpNativeTextarea = getCommentTextareaFromForm(wpNativeForm);
    if (wpNativeTextarea) {
      console.log('[AutoComment] 优先命中 WordPress 原生评论框:', {
        formId: wpNativeForm.id,
        formClass: wpNativeForm.className,
        textareaId: wpNativeTextarea.id,
        textareaName: wpNativeTextarea.name
      });
      return wpNativeTextarea;
    }

    // 方法0: 检测 wpDiscuz 可编辑 div（ contenteditable 评论框）
    const wpDiscuzEditor = findWpDiscuzEditor();
    if (wpDiscuzEditor) {
      console.log('[AutoComment] 找到 wpDiscuz 编辑器:', wpDiscuzEditor.className);
      const form = wpDiscuzEditor.closest('form');
      if (form) {
        commentForms.add(form);
      }
      // 返回一个兼容对象，模拟 textarea
      return {
        _isWpDiscuz: true,
        _realElement: wpDiscuzEditor,
        get value() { return this._realElement.textContent || ''; },
        set value(v) { this._realElement.textContent = v; },
        form: form,
        closest: wpDiscuzEditor.closest.bind(wpDiscuzEditor),
        querySelector: wpDiscuzEditor.querySelector.bind(wpDiscuzEditor),
        querySelectorAll: wpDiscuzEditor.querySelectorAll.bind(wpDiscuzEditor)
      };
    }

    // 方法1: 通过标准的 WordPress/comment 选择器直接查找
    const standardSelectors = [
      '#comment',
      'textarea[name="comment"]',
      'textarea#comment',
      'textarea[id="comment"]',
      'textarea[name="comment_content"]',
      'textarea[id="comment_content"]',
      'textarea[name="comments"]',
      'textarea#comments',
      'textarea.wpcf7-textarea'
    ];

    for (const selector of standardSelectors) {
      try {
        const ta = document.querySelector(selector);
        if (ta && !commentTextareas.includes(ta)) {
          commentTextareas.push(ta);
          const form = ta.form || (ta.closest && ta.closest('form'));
          if (form) {
            commentForms.add(form);
          }
        }
      } catch (e) {
        // 忽略无效选择器
      }
    }

    // 方法2: 通过关键词匹配
    allTextareas.forEach((ta) => {
      if (commentTextareas.includes(ta)) return; // 避免重复

      const name = (ta.name || '').toLowerCase();
      const id = (ta.id || '').toLowerCase();
      const placeholder = (ta.placeholder || '').toLowerCase();
      const ariaLabel = (ta.getAttribute('aria-label') || '').toLowerCase();
      const text = `${name} ${id} ${placeholder} ${ariaLabel}`;

      const keywords = [
        'comment',
        'comentario',
        'reply',
        'respuesta',
        'message',
        'mensaje',
        'review',
        'reseña',
        'feedback',
        'opinion',
        'opinión',
        'commenttext',
        '留言',
        '评论',
        '回复',
        '响应',
        // 泰语相关
        'ความคิดเห็น',     // ความคิดเห็น = 评论
        'แสดง',           // แสดง = 显示/发表
        'ข้อความ',        // ข้อความ = 消息/文本
        'ตอบ',            // ตอบ = 回复
        // 英语通用评论关键词
        'leave a comment',
        'write a comment',
        'post a comment',
        'cancel reply',
        'subscribe',
        // 增强：fullcirclecinema 等博客/新闻站点
        'what do you think',
        'share your thoughts',
        'type here',
        'enter your comment',
      ];
      if (keywords.some((k) => text.includes(k))) {
        commentTextareas.push(ta);
        const form = ta.form || (ta.closest && ta.closest('form'));
        if (form) {
          commentForms.add(form);
        }
      }
    });

    // 方法3: 通过表单的 class/id/keyword 检测 WordPress 和其他常见表单
    if (commentForms.size === 0) {
      const forms = Array.from(document.querySelectorAll('form'));
      forms.forEach((form) => {
        const text = (form.textContent || '').toLowerCase();
        const className = (form.className || '').toLowerCase();
        const id = (form.id || '').toLowerCase();
        const action = (form.action || '').toString().toLowerCase();

        // WordPress 和其他评论表单关键词（增强：添加泰语/葡萄牙语/西班牙语关键词）
        const keywords = [
          'deja una respuesta',
          'deja un comentario',
          'tu dirección de correo electrónico no será publicada',
          'comentario *',
          'leave a reply',
          'leave a comment',
          'post comment',
          'submit comment',
          'your name',
          'your email',
          'your comment',
          '姓名',
          '邮箱',
          '评论',
          '留言',
          '回复',
          'be first to comment',
          'cancel reply',
          'logged in as',
          // 泰语评论相关
          'ความคิดเห็น',         // ความคิดเห็น = 评论
          'แสดงความคิดเห็น',    // แสดงความคิดเห็น = 发表意见
          'ตอบกลับ',            // ตอบกลับ = 回复
          // 葡萄牙语评论相关
          'deixe um comentário',
          'deixe um comentario',
          'deixe um comentário',
          'comentário',
          'comentario',
          'seu nome',
          'seu email',
          'seu comentário',
          'seu comentario',
          'enviar comentário',
          'enviar comentario',
          'required fields',
          'campos obrigatórios',
          'campos obligatorios',
          'endereço de email',
          'endereço não será publicado',
          // 西班牙语评论相关
          'dejar un comentario',
          'tu nombre',
          'tu correo',
          'tu comentario',
          'enviar comentario',
          'campos requeridos',
          // Contact Form 7 通用关键词
          'your name',
          'your e-mail',
          'your email',
          'your message',
          'your subject',
          'subject:',
          'e-mail address',
          'email address',
          'phone',
          'tel:',
          'send',
          'submit',
          'send message',
          'send inquiry',
          'book',
          'order',
          'inquiry',
          'contact form',
          'Save my name',
          'will not be published',
          'required fields',
          'fields are marked',
          // SyncedReview 等站点的评论按钮文本
          'post comment',
          'leave a reply',
          'add comment',
          'follow-up comments',
          'new posts by email',
          'new comments',
          // fullcirclecinema 等电影/博客站点关键词
          'cancel reply',
          'you must be logged in',
          'logged in as',
          'notify me of',
          'want to join the discussion',
          'join the discussion',
          'subscribe to our'
        ];

        // WordPress 和其他表单选择器
        const formSelectors = [
          '#commentform',
          '.comment-form',
          '.commentform',
          '#respond',
          '.respond',
          '.comment-respond',
          '.wpcf7-form',
          '[class*="comment-form"]',
          '[id*="comment-form"]',
          '[class*="respond"]',
          '[id*="respond"]',
          'form[action*="comment"]',
          'form[id*="comment"]',
          'form[class*="comment"]',
          // SyncedReview 等站点
          'form[action=""]',
          'form[action="/wp-comments-post.php"]'
        ];

        const isWordPressForm = formSelectors.some(sel => {
          try {
            return document.querySelector(sel) === form;
          } catch (e) {
            return className.includes(sel.replace('#', '').replace('.', ''));
          }
        });

        const hasKeyword = keywords.some((k) => text.includes(k));
        const hasWPForm = isWordPressForm || action.includes('wp-comments-post') || action.includes('comment');

        if (hasKeyword || hasWPForm) {
          commentForms.add(form);
        }
      });
    }

    // 方法4: 在评论区域附近查找 textarea
    if (commentForms.size === 0) {
      const commentAreaSelectors = [
        '#comments',
        '.comments',
        '.comment-section',
        '#respond',
        '.respond',
        '.reply',
        '#comments-section',
        '.comments-area',
        '.comment-list',
        '.commentarea',
        '[class*="comment-area"]',
        '[id*="comment-area"]',
        // 增强：更多 WordPress 主题常见类名
        '.comment-respond',
        '#comment-respond',
        '.wp-comments-area',
        '.comments-area',
        '.comment-wrapper',
        '.entry-comments',
        '.post-comments',
        '.comment-body-wrapper',
        '#comments-area',
        // 增强：嵌套回复容器
        '.comment-inner',
        '.comment-content',
        '.comment_container',
        '#comment_container',
        '[id*="div-comment"]',
        '[class*="depth"]',
        // 葡萄牙语/西班牙语评论区域
        '.comentarios',
        '#comentarios',
        '.comentario',
        '#comentario',
        '[class*="comentario"]',
        '.deixe-comentario',
        '.deixe-um-comentario',
        '.dejar-comentario',
        '.dejar-un-comentario',
        '.comentarios-section',
        '.post-comments-area',
        // 增强：fullcirclecinema 等电影/博客站点的评论容器
        '.post-comments',
        '#post-comments',
        '.entry-comments',
        '#entry-comments',
        '.commentlist',
        '#commentlist',
        '.comment-body',
        '.commentlist-content',
        // 增强：更多评论区域变体
        '.post-comment',
        '#post-comment',
        '.article-comments',
        '.story-comments'
      ];

      for (const selector of commentAreaSelectors) {
        try {
          const areas = document.querySelectorAll(selector);
          areas.forEach(area => {
            // 在评论区域内查找所有 textarea
            const areaTextareas = area.querySelectorAll('textarea');
            areaTextareas.forEach(ta => {
              if (!commentTextareas.includes(ta)) {
                commentTextareas.push(ta);
              }
            });

            // 如果区域在表单内，获取表单
            const form = area.closest ? area.closest('form') : null;
            if (form) {
              commentForms.add(form);
            }
          });
        } catch (e) {
          // 忽略无效选择器
        }
      }
    }

    // 方法5: 检测 Disqus 评论系统
    if (commentForms.size === 0 && commentTextareas.length === 0) {
      const disqusIndicator = document.querySelector(
        '#disqus_thread, ' +
        '[id*="disqus"], ' +
        'iframe[src*="disqus"], ' +
        '.dsq-brlink, ' +
        '#disqus_thread_injection'
      );
      if (disqusIndicator) {
        console.log('[AutoComment] 检测到 Disqus 评论系统:', disqusIndicator.id || disqusIndicator.className);
        // Disqus 需要用户点击 "Join the discussion" 或类似按钮来展开评论框
        // 尝试点击展开 Disqus 评论框
        const disqusOpenBtn = document.querySelector(
          '#disqus_thread a, ' +
          '[id*="disqus"] a, ' +
          '.dsq-brlink a, ' +
          'a[href*="disqus"], ' +
          // Disqus 通用展开按钮
          '#disqus_thread button, ' +
          '.disqus-comment-count, ' +
          '[data-disqus-identifier]'
        );
        if (disqusOpenBtn && !disqusOpenBtn.hasAttribute('data-auto-comment-clicked')) {
          console.log('[AutoComment] 点击 Disqus 展开按钮');
          disqusOpenBtn.setAttribute('data-auto-comment-clicked', 'true');
          disqusOpenBtn.click();
          // 返回一个占位对象，稍后会再次检测
          return {
            _isDisqusPlaceholder: true,
            _disqusIndicator: disqusIndicator,
            value: '',
            get value() { return ''; },
            set value(v) { /* ignore */ },
            form: null,
            closest: disqusIndicator.closest.bind(disqusIndicator),
            querySelector: disqusIndicator.querySelector.bind(disqusIndicator),
            querySelectorAll: disqusIndicator.querySelectorAll.bind(disqusIndicator)
          };
        }
      }
    }

    let targetTextarea = null;

    if (commentTextareas.length > 0) {
      targetTextarea = commentTextareas[0];
    } else if (commentForms.size > 0) {
      for (const form of commentForms) {
        const formTextareas = Array.from(form.querySelectorAll('textarea'));
        if (formTextareas.length > 0) {
          targetTextarea = formTextareas[0];
          break;
        }
      }
    }

    if (!targetTextarea && allowGenericFallback) {
      targetTextarea = allTextareas[0];
    }

    return targetTextarea || null;
  }

  // ====== 通用评论提交按钮检测函数 ======
  /**
   * 输入: 无（依赖 DOM）
   * 输出: { form, button } 与当前评论框同一表单的提交控件，避免与页面上其它表单的 submit 混淆
   */
  function resolveCommentFormAndSubmitButton() {
    const ta = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (ta) {
      const form = ta.form || (ta.closest && ta.closest('form'));
      if (form) {
        const btn = findSubmitButtonInForm(form);
        if (btn) return { form, button: btn };
      }
    }
    const commentForm = findCommentForm();
    if (commentForm) {
      const btn = findSubmitButtonInForm(commentForm);
      if (btn) return { form: commentForm, button: btn };
    }
    const standalone = findStandaloneSubmitButton();
    if (standalone) {
      const form =
        standalone.form ||
        (standalone.closest && standalone.closest('form')) ||
        null;
      return { form, button: standalone };
    }
    return { form: null, button: null };
  }

  function findCommentSubmitButton() {
    return resolveCommentFormAndSubmitButton().button;
  }

  /**
   * 查找 wpDiscuz 可编辑 div 评论框
   */
  function findWpDiscuzEditor() {
    // wpDiscuz 常用选择器
    const selectors = [
      '.wpdiscuz-comment-text-wrap',
      '.wpd-form-input',
      '.wpd-form-field',
      'div[id*="wpdiscuz"]',
      'div[class*="wpdiscuz"]',
      '[contenteditable="true"]'
    ];
    
    for (const sel of selectors) {
      try {
        const editors = document.querySelectorAll(sel);
        for (const editor of editors) {
          // 检查是否是可编辑的评论框
          const isEditable = editor.getAttribute('contenteditable') === 'true' || 
                           editor.className.includes('wpdiscuz') ||
                           editor.id.includes('wpdiscuz');
          if (isEditable) {
            // 进一步验证：在评论区域附近
            const commentWrap = editor.closest('#comments, .comments, .comment-section, .wpd-thread');
            if (commentWrap || editor.querySelector('p, span, div')) {
              return editor;
            }
          }
        }
      } catch (e) {}
    }
    
    // 备用：查找所有 contenteditable 元素并筛选
    const allEditable = document.querySelectorAll('[contenteditable="true"]');
    for (const el of allEditable) {
      const className = (el.className || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const parent = el.closest('#comments, .comments, .comment-section');
      
      if ((className.includes('wpdiscuz') || id.includes('wpdiscuz') || parent) &&
          el.querySelector('p, span, div')) {
        return el;
      }
    }
    
    return null;
  }

  // 查找评论表单
  function findCommentForm() {
    // ── 方案A：直接用 WordPress 标准 form 选择器 ─────────────
    const formSelectors = [
      '#commentform',
      '.comment-form',
      '.commentform',
      'form[name="commentform"]',
      'form[id="commentform"]',
      'form[class*="comment-form"]',
      'form[id*="comment-form"]'
    ];
    for (const sel of formSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.tagName === 'FORM') {
          console.log('[AutoComment] 方案A找到表单:', sel);
          return el;
        }
      } catch (_) {}
    }

    // ── 方案B：先找 textarea，再用 ta.form / closest('form') ──
    const textarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (textarea) {
      if (textarea.form) {
        console.log('[AutoComment] 方案B通过 textarea.form 找到表单');
        return textarea.form;
      }
      if (textarea.closest) {
        const parentForm = textarea.closest('form');
        if (parentForm) {
          console.log('[AutoComment] 方案B通过 textarea.closest("form") 找到表单');
          return parentForm;
        }
      }
    }

    // ── 方案C：在评论区域附近找 form ─────────────────────────
    const areaSelectors = [
      '#comments', '#respond', '.comment-respond',
      '#comments-section', '.comments-area', '.comment-section'
    ];
    for (const sel of areaSelectors) {
      const area = document.querySelector(sel);
      if (area) {
        const f = area.querySelector('form') || (area.closest ? area.closest('form') : null);
        if (f) {
          console.log('[AutoComment] 方案C通过评论区域找到表单:', sel);
          return f;
        }
      }
    }

    // ── 方案D：直接找页面所有表单中含 comment/respond 关键词的 ─
    const allForms = Array.from(document.querySelectorAll('form'));
    for (const f of allForms) {
      const text = (f.textContent || '').toLowerCase();
      const cls = (f.className || '').toLowerCase();
      const fid = (f.id || '').toLowerCase();
      if (text.includes('comment') || text.includes('respond') ||
          cls.includes('comment') || fid.includes('comment') ||
          cls.includes('respond') || fid.includes('respond')) {
        console.log('[AutoComment] 方案D通过关键词找到表单:', f.id, f.className);
        return f;
      }
    }

    // ── 以下为原逻辑（备选方案）──────────────────────────────
    // 方法0: 检测 wpDiscuz
    const wpDiscuzEditor = findWpDiscuzEditor();
    if (wpDiscuzEditor) {
      const form = wpDiscuzEditor.closest('form');
      if (form) return form;
    }

    // 方法1: 通过 textarea 关联的表单
    const commentTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (commentTextarea) {
      const form = commentTextarea.form || (commentTextarea.closest && commentTextarea.closest('form'));
      if (form) return form;
    }

    // 方法2: 通过表单 class/id 查找
    const legacySelectors = [
      '#commentform',
      '.comment-form',
      '.commentform',
      '#respond',
      '.respond',
      '.comment-respond',
      'form[name="commentform"]',
      'form[id*="comment"]',
      'form[class*="comment"]',
      'form[action*="comment"]'
    ];

    for (const selector of legacySelectors) {
      const form = document.querySelector(selector);
      if (form) return form;
    }

    // 方法3: 通过关键词文本查找
    const forms = Array.from(document.querySelectorAll('form'));
    for (const form of forms) {
      const text = (form.textContent || '').toLowerCase();
      const className = (form.className || '').toLowerCase();
      const id = (form.id || '').toLowerCase();

      const keywords = [
        'comment', 'reply', 'respond', '留言', '评论', '回复',
        'post a comment', 'post comment', 'submit comment', 'leave a reply'
      ];

      if (keywords.some(k => text.includes(k) || className.includes(k) || id.includes(k))) {
        return form;
      }
    }

    // 方法4: 通过评论区域查找
    const commentAreaSelectors = [
      '#comments', '.comments', '.comment-section', '#respond',
      '.respond', '.reply', '#comments-section', '.comments-area'
    ];

    for (const selector of commentAreaSelectors) {
      const area = document.querySelector(selector);
      if (area) {
        const form = area.querySelector('form') || area.closest('form');
        if (form) return form;
      }
    }

    return null;
  }

  // 在指定表单中查找提交按钮
  function findSubmitButtonInForm(form) {
    if (!form) return null;

    // 方法1: 通过标准 WordPress 选择器直接查找
    const wpSelectors = [
      '#submit',
      '#submit-btn',
      '#publish',
      'input#submit',
      'input[type="submit"]#submit',
      '.submit',
      'input.submit',
      'button.submit',
      '[name="submit"]',
      'input[name="submit"]',
      'button[name="submit"]',
      'input[type="submit"][name="submit"]',
      'input[name="publish"]',
      'button[name="publish"]',
      '.publish',
      '#wp-submit',
      // wpDiscuz 特定选择器
      '.wpd-submit-btn',
      '.wpdiscuz-submit-btn',
      '.wpd-button',
      'button[id*="wpdiscuz"]',
      'button[class*="wpdiscuz"]',
      '#wpdtdfьи_submit',
      '.wc_comment_submit'
    ];

    for (const selector of wpSelectors) {
      try {
        const btn = form.querySelector(selector);
        if (btn) {
          console.log('[AutoComment] 通过 WordPress 选择器找到提交按钮:', selector);
          return btn;
        }
      } catch (e) {
        // 忽略无效选择器
      }
    }

    // 方法2: 查找所有可能的提交元素（表单内无 type 的 button 默认为 submit）
    const candidates = form.querySelectorAll(
      'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"], [role="submit"]'
    );

    if (candidates.length > 0) {
      // 优先返回有明确提交相关的按钮
      for (const btn of candidates) {
        const value = (btn.value || '').toLowerCase();
        const className = (btn.className || '').toLowerCase();
        const id = (btn.id || '').toLowerCase();
        const text = (btn.textContent || '').toLowerCase();

        // 检查是否包含提交相关关键词（包含西班牙语和 publish）
        const submitKeywords = [
          'submit', 'post', 'comment', 'publish', 'publicar',
          'responder', 'enviar', 'reply', 'send', 'comentar',
          'replicar', 'dejar', 'commentaire', 'comentar',
          'anzeigen', 'absenden', '回答', '返信',
          'post a comment'
        ];

        if (submitKeywords.some(k => value.includes(k) || className.includes(k) || id.includes(k) || text.includes(k))) {
          console.log('[AutoComment] 通过关键词找到提交按钮:', { value, className, id, text });
          return btn;
        }
      }

      // 如果没有找到关键词匹配，返回第一个
      console.log('[AutoComment] 找到提交按钮（第一个）:', candidates[0].tagName);
      return candidates[0];
    }

    // 方法3: 通过文本内容查找（包括 input value）
    const allButtons = form.querySelectorAll('button, input[type="button"]');
    for (const btn of allButtons) {
      const text = (btn.textContent || btn.value || '').toLowerCase().trim();
      const className = (btn.className || '').toLowerCase();
      const id = (btn.id || '').toLowerCase();

      const submitKeywords = [
        'submit', 'post', 'comment', 'reply', 'respond', 'publish',
        '提交', '评论', '发送', 'publicar', 'responder', 'enviar',
        'post comment', 'submit comment', 'post a comment'
      ];

      if (submitKeywords.some(k => text.includes(k) || className.includes(k) || id.includes(k))) {
        console.log('[AutoComment] 通过文本找到提交按钮:', { text, className, id });
        return btn;
      }
    }

    // 如果表单只有一个按钮，返回它
    if (allButtons.length === 1) {
      console.log('[AutoComment] 表单只有一个按钮，返回它');
      return allButtons[0];
    }

    // 方法4: 返回表单内的第一个提交类型输入
    const submitInputs = form.querySelectorAll('input');
    for (const input of submitInputs) {
      const type = (input.type || '').toLowerCase();
      if (type === 'submit' || type === 'image') {
        console.log('[AutoComment] 返回第一个 submit input');
        return input;
      }
    }

    return null;
  }

  // 查找独立的提交按钮（不在表单内但在评论区域附近）
  function findStandaloneSubmitButton() {
    const submitKeywords = [
      'submit', 'post', 'comment', 'publish', 'respond', 'reply',
      '提交', '评论', '发送', 'publicar', 'responder', 'enviar',
      'comentar', 'dejar', 'anzeigen', 'absenden', '回答', '返信'
    ];

    // 方法1: 通过 class/id 查找常见提交按钮选择器
    const commonSelectors = [
      '#submit',
      '#submit-btn',
      '#submit-button',
      '#publish',
      '#wp-submit',
      'input#submit',
      'input[type="submit"]#submit',
      '.submit',
      '.submit-btn',
      '.submit-button',
      '.publish',
      'input.submit',
      'button.submit',
      '.comment-submit',
      '.post-comment',
      '#post-comment',
      '.btn-submit',
      '.submit-comment',
      '.wpcf7-submit',
      '#wpcf7-submit',
      '.form-submit',
      '#form-submit'
    ];

    for (const selector of commonSelectors) {
      try {
        const btn = document.querySelector(selector);
        if (btn) {
          console.log('[AutoComment] 通过选择器找到独立提交按钮:', selector);
          return btn;
        }
      } catch (e) {
        // 忽略无效选择器
      }
    }

    // 方法2: 直接查找所有提交按钮
    const submitButtons = document.querySelectorAll(
      'button[type="submit"], input[type="submit"], input[type="image"]'
    );

    for (const btn of submitButtons) {
      const text = (btn.textContent || btn.value || '').toLowerCase();
      const className = (btn.className || '').toLowerCase();
      const id = (btn.id || '').toLowerCase();
      const name = (btn.name || '').toLowerCase();

      // 检查是否包含提交相关关键词
      if (submitKeywords.some(k =>
        text.includes(k) ||
        className.includes(k) ||
        id.includes(k) ||
        name.includes(k)
      )) {
        console.log('[AutoComment] 通过关键词找到独立提交按钮:', { text, className, id });
        return btn;
      }
    }

    // 方法3: 返回页面中的第一个提交按钮（在评论区域附近）
    const commentAreas = document.querySelectorAll(
      '#comments, .comments, .comment-section, #respond, .respond, .reply, .comment-respond, ' +
      '.comments-area, .commentlist, .comment-area, #comments-section, .comments-section'
    );

    for (const area of commentAreas) {
      // 在评论区域查找提交按钮
      const areaButtons = area.querySelectorAll(
        'button[type="submit"], input[type="submit"], input[type="image"]'
      );
      for (const btn of areaButtons) {
        console.log('[AutoComment] 在评论区域找到提交按钮');
        return btn;
      }

      // 在评论区域查找带有提交关键词的按钮
      const allButtons = area.querySelectorAll('button, input[type="button"]');
      for (const btn of allButtons) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (submitKeywords.some(k => text.includes(k))) {
          console.log('[AutoComment] 在评论区域通过关键词找到按钮');
          return btn;
        }
      }
    }

    // 方法4: 如果只有一个提交按钮，直接返回
    if (submitButtons.length === 1) {
      console.log('[AutoComment] 页面只有一个提交按钮，返回它');
      return submitButtons[0];
    }

    return null;
  }

  // 检查按钮是否可见且可点击
  function isButtonClickable(button) {
    if (!button) return false;

    // 检查 disabled 状态
    if (button.disabled) {
      console.log('[AutoComment] 按钮被禁用');
      return false;
    }

    if (button.getAttribute('aria-disabled') === 'true') {
      console.log('[AutoComment] 按钮 aria-disabled 为 true');
      return false;
    }

    const style = window.getComputedStyle(button);
    const rect = button.getBoundingClientRect();

    // 检查是否可见
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      console.log('[AutoComment] 按钮不可见:', { display: style.display, visibility: style.visibility, opacity: style.opacity });
      return false;
    }

    // 检查尺寸
    if (rect.width === 0 || rect.height === 0) {
      console.log('[AutoComment] 按钮尺寸为0:', { width: rect.width, height: rect.height });
      return false;
    }

    // 检查是否在视口内（允许部分可见）
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

    // 至少部分可见即可
    const isPartiallyVisible = !(rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth);

    if (!isPartiallyVisible) {
      console.log('[AutoComment] 按钮不在视口内，尝试立即滚动（避免 smooth 未完成导致坐标错误）');
      try {
        button.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
        return true;
      } catch (e) {
        console.log('[AutoComment] 滚动失败', { errorCode: 'scroll_failed' });
        return false;
      }
    }

    return true;
  }

  // 点击提交按钮并处理结果
  async function clickCommentSubmitButton() {
    console.log('[AutoComment] ===== 开始自动提交评论 =====');

    // 列出页面上所有按钮供调试
    const allButtons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a[class*="submit"], input[type="image"]');
    console.log('[AutoComment] 页面中所有按钮/链接:', Array.from(allButtons).map(b => ({
      tagName: b.tagName,
      type: b.type,
      id: b.id,
      className: b.className,
      name: b.name,
      disabled: Boolean(b.disabled)
    })));

    const resolved = resolveCommentFormAndSubmitButton();
    const form = resolved.form;
    const button = resolved.button;
    console.log('[AutoComment] resolveCommentFormAndSubmitButton:', {
      formId: form ? form.id : null,
      formClass: form ? form.className : null,
      buttonTag: button ? button.tagName : null,
      buttonId: button ? button.id : null
    });

    if (!button) {
      globalThis.AutoCommentReportBatchDiagnostic?.(
        _batchCtx,
        'submit_control_unusable',
        {
        buttonClickable: false,
        buttonDisabled: false
        }
      );
      console.log('[AutoComment] 未找到任何提交按钮');
      return { success: false, error: '未找到评论提交按钮' };
    }

    return await performClick(button);
  }

  /**
   * 等待页面导航发生（页面刷新/跳转/隐藏时立即 resolve；超时则 resolve）
   * 用于：点击提交按钮后等待页面响应，以确认是否成功触发表单提交
   */
  async function waitForNavigate(timeoutMs = 8000) {
    return new Promise((resolve) => {
      let resolved = false;
      function finish(result) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      }
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('beforeunload', onBeforeUnload);
        window.removeEventListener('pagehide', onPageHide);
      }
      function onBeforeUnload() { finish('navigating'); }
      function onPageHide(e) { finish(e.persisted ? 'pagehide-persisted' : 'pagehide'); }
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      window.addEventListener('beforeunload', onBeforeUnload);
      window.addEventListener('pagehide', onPageHide);
    });
  }

  const SUBMISSION_NAVIGATION_RESULTS = new Set([
    'navigating',
    'pagehide',
    'pagehide-persisted'
  ]);

  function isSubmissionNavigationResult(result) {
    return SUBMISSION_NAVIGATION_RESULTS.has(result);
  }

  function isSuccessfulSubmissionResponse(response) {
    if (!response) return false;
    if (typeof response.ok === 'boolean') return response.ok;
    const status = Number(response.status);
    return Number.isFinite(status) && status >= 200 && status < 400;
  }

  function getSubmissionRequestDetails(input, init) {
    const url = (
      typeof input === 'string'
        ? input
        : (input?.url || input)
    );
    const method = String(
      init?.method || input?.method || 'GET'
    ).toUpperCase();
    return { url, method };
  }

  /**
   * 等待可验证的提交结果。submit 事件和请求开始都不能代表服务器已接受评论：
   * - 原生表单只报告页面开始导航，交给新文档恢复逻辑确认；
   * - fetch/XHR 必须等响应完成；
   * - PerformanceObserver 用于观察页面主世界发起、内容脚本无法直接包装的请求。
   */
  function waitForSubmitOrNavigate(timeoutMs = 10000, form = null) {
    return new Promise((resolve) => {
      let resolved = false;
      let performanceObserver = null;
      const expectedAction = form?.action || '';
      function finish(result) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      }
      function cleanup() {
        clearTimeout(timer);
        if (window.XMLHttpRequest) {
          window.XMLHttpRequest.prototype.open = originalXHROpen;
          window.XMLHttpRequest.prototype.send = originalXHRSend;
        }
        if (window.fetch) {
          window.fetch = originalFetch;
        }
        if (performanceObserver) {
          performanceObserver.disconnect();
        }
        window.removeEventListener('beforeunload', onBeforeUnload);
        window.removeEventListener('pagehide', onPageHide);
      }
      function onBeforeUnload() { finish('navigating'); }
      function onPageHide(e) {
        finish(e.persisted ? 'pagehide-persisted' : 'pagehide');
      }

      // 内容脚本自身发起的 fetch：必须等待响应或异常。
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        const details = getSubmissionRequestDetails(input, init);
        let request;
        try {
          request = originalFetch.apply(this, arguments);
        } catch (error) {
          if (
            details.method !== 'GET'
            && isFormSubmitUrl(details.url, expectedAction)
          ) {
            finish('ajax-failure');
          }
          throw error;
        }
        if (
          !resolved
          && details.method !== 'GET'
          && isFormSubmitUrl(details.url, expectedAction)
        ) {
          Promise.resolve(request).then(
            (response) => finish(
              isSuccessfulSubmissionResponse(response)
                ? 'ajax-success'
                : 'ajax-failure'
            ),
            () => finish('ajax-failure')
          );
        }
        return request;
      };

      // 内容脚本自身发起的 XHR：open 只记录请求，loadend 后才判定。
      const originalXHROpen = window.XMLHttpRequest.prototype.open;
      const originalXHRSend = window.XMLHttpRequest.prototype.send;
      window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__autoCommentSubmissionRequest = {
          method: String(method || 'GET').toUpperCase(),
          url
        };
        return originalXHROpen.call(this, method, url, ...rest);
      };
      window.XMLHttpRequest.prototype.send = function(...args) {
        const details = this.__autoCommentSubmissionRequest;
        if (
          !resolved
          && details?.method !== 'GET'
          && isFormSubmitUrl(details?.url, expectedAction)
        ) {
          const onLoadEnd = () => {
            this.removeEventListener('loadend', onLoadEnd);
            finish(
              Number(this.status) >= 200 && Number(this.status) < 400
                ? 'ajax-success'
                : 'ajax-failure'
            );
          };
          this.addEventListener('loadend', onLoadEnd);
        }
        return originalXHRSend.apply(this, args);
      };

      window.addEventListener('beforeunload', onBeforeUnload);
      window.addEventListener('pagehide', onPageHide);

      // 页面脚本运行在主世界，不能被内容脚本的 fetch/XHR 包装直接观察。
      // Resource Timing 条目只会在请求完成后产生，因此不会把“开始发送”误判为成功。
      if (typeof PerformanceObserver === 'function') {
        try {
          performanceObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const initiator = String(entry.initiatorType || '').toLowerCase();
              if (
                ['fetch', 'xmlhttprequest'].includes(initiator)
                && isFormSubmitUrl(entry.name, expectedAction)
              ) {
                finish('ajax-complete');
                break;
              }
            }
          });
          performanceObserver.observe({ type: 'resource', buffered: false });
        } catch (_) {
          performanceObserver = null;
        }
      }

      const timer = setTimeout(() => finish('timeout'), timeoutMs);
    });
  }

  /**
   * 判断 URL 是否可能是评论表单提交地址
   * 排除静态资源和图片，只拦截看起来像 API/表单提交的 URL
   */
  function isFormSubmitUrl(url, expectedAction = '') {
    if (!url) return false;
    const s = String(url).toLowerCase();
    // 排除静态资源和常见非提交地址
    const excludePatterns = [
      /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|mp4|webm|ogg|mp3|wav|zip|tar|gz)$/,
      /google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|analytics|tracking|pixel/i,
    ];
    for (const p of excludePatterns) {
      if (p.test(s)) return false;
    }
    try {
      const candidate = new URL(String(url), location.href);
      if (expectedAction) {
        const expected = new URL(String(expectedAction), location.href);
        if (
          candidate.origin === expected.origin
          && candidate.pathname === expected.pathname
        ) {
          return true;
        }
      }
      return /(?:comment|reply|review|discussion|feedback|submission|admin-ajax)/
        .test(candidate.pathname.toLowerCase());
    } catch (_) {
      return /(?:comment|reply|review|discussion|feedback|submission|admin-ajax)/
        .test(s);
    }
  }

  function requestSubmissionVerificationReload() {
    try {
      if (typeof window.location?.reload !== 'function') return false;
      window.location.reload();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function confirmDispatchedSubmissionResult(submitResult) {
    if (isSubmissionNavigationResult(submitResult)) {
      return {
        confirmed: false,
        navigationPending: true,
        reason: '原生表单导航已开始，等待新页面确认',
        status: 'verification-navigation'
      };
    }
    if (submitResult === 'ajax-failure') {
      return {
        confirmed: false,
        navigationPending: false,
        reason: '评论提交请求失败或服务器返回错误状态',
        status: 'rejected'
      };
    }
    if (!['ajax-success', 'ajax-complete'].includes(submitResult)) {
      return {
        confirmed: false,
        navigationPending: false,
        reason: '提交超时，未收到服务器响应'
      };
    }

    // 给页面的 AJAX 完成回调留出更新错误提示的时间，然后刷新并在新文档中
    // 通过评论文本、审核提示或明确错误完成三态确认。
    await new Promise(resolve => setTimeout(resolve, 700));
    const outcome = inspectSubmissionDocument({
      allowClearedTextarea: false
    });
    if (outcome.status === 'rejected') {
      return {
        confirmed: false,
        navigationPending: false,
        reason: outcome.reason,
        status: 'rejected'
      };
    }
    if (requestSubmissionVerificationReload()) {
      return {
        confirmed: false,
        navigationPending: true,
        reason: '提交请求已完成，正在刷新页面验证评论状态',
        status: 'verification-reload'
      };
    }
    return {
      confirmed: outcome.status === 'success',
      navigationPending: false,
      reason: outcome.reason,
      status: outcome.status
    };
  }

  // 执行点击操作
  async function performClick(button) {
    console.log('[AutoComment] 找到提交按钮:', {
      tagName: button.tagName,
      type: button.type,
      id: button.id,
      className: button.className,
      name: button.name,
      disabled: button.disabled
    });

    // 获取评论文本框内容用于确认
    const commentTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (commentTextarea) {
      console.log('[AutoComment] 评论文本框状态:', {
        filled: Boolean(commentTextarea.value),
        length: commentTextarea.value?.length || 0
      });
    }

    const buttonClickable = isButtonClickable(button);
    const formEl = button.form || button.closest('form');
    globalThis.AutoCommentReportBatchDiagnostic?.(
      _batchCtx,
      'submit_control_detected',
      {
      submitTag: String(button.tagName || '').toLowerCase(),
      submitType: String(button.type || '').toLowerCase() || 'unknown',
      formMethod: String(
        button.form?.method ||
        button.closest('form')?.method ||
        'get'
      ).toLowerCase(),
      buttonDisabled: Boolean(
        button.disabled ||
        button.getAttribute('aria-disabled') === 'true'
      ),
      buttonClickable,
      filled: Boolean(commentTextarea?.value),
      contentLength: commentTextarea?.value?.length || 0
      }
    );

    async function tryRequestSubmit(targetForm, submitter) {
      if (!targetForm) return false;
      if (typeof targetForm.requestSubmit === 'function') {
        try {
          await globalThis.AutoCommentReportBatchDiagnostic?.(
            _batchCtx,
            'submission_strategy_selected',
            { strategy: 'request-submit' }
          );
          targetForm.requestSubmit(submitter);
          return true;
        } catch (err) {
          console.log('[AutoComment] requestSubmit 失败', {
            errorCode: 'request_submit_failed'
          });
        }
      }
      return false;
    }

    if (!buttonClickable) {
      globalThis.AutoCommentReportBatchDiagnostic?.(
        _batchCtx,
        'submit_control_unusable',
        {
        buttonDisabled: Boolean(
          button.disabled ||
          button.getAttribute('aria-disabled') === 'true'
        ),
        buttonClickable: false
        }
      );
      // 后台标签页中，按钮可能因为没有可见布局而被判断为不可点击。
      // requestSubmit 不依赖屏幕坐标，并且仍会执行原生表单校验。
      if (formEl && typeof formEl.requestSubmit === 'function') {
        const submitDetection = waitForSubmitOrNavigate(10000, formEl);
        if (await tryRequestSubmit(formEl, button)) {
          recordFormSubmit();
          const submitResult = await submitDetection;
          return {
            success: true,
            button,
            submitResult,
            strategy: 'request-submit'
          };
        }
      }
      console.log('[AutoComment] 提交按钮不可见或被禁用，表单降级提交失败');
      return { success: false, error: '提交按钮不可见或被禁用' };
    }

    // 必须在触发点击前安装监听。部分站点会同步派发 submit，点击后再监听会漏报成功。
    const submitDetection = waitForSubmitOrNavigate(
      10000,
      formEl
    );

    try {
      // worker 标签页以 active:false 打开。后台页的 requestAnimationFrame 可能永久暂停，
      // 因此不能等待动画帧；auto 滚动加 getBoundingClientRect 会同步刷新布局。
      button.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });

      console.log('[AutoComment] 尝试点击提交按钮...');

      const rect = button.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);

      const pointerOpts = {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        view: window
      };

      try {
        await globalThis.AutoCommentReportBatchDiagnostic?.(
          _batchCtx,
          'submission_strategy_selected',
          { strategy: 'synthetic-pointer' }
        );
        if (typeof PointerEvent !== 'undefined') {
          button.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
          await new Promise(resolve => setTimeout(resolve, 20));
        }

        button.dispatchEvent(new MouseEvent('mousedown', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY
        }));
        await new Promise(resolve => setTimeout(resolve, 40));

        button.dispatchEvent(new MouseEvent('mouseup', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY
        }));
        await new Promise(resolve => setTimeout(resolve, 20));

        if (typeof PointerEvent !== 'undefined') {
          button.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
          await new Promise(resolve => setTimeout(resolve, 20));
        }

        button.dispatchEvent(new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY
        }));

        recordFormSubmit();

        console.log('[AutoComment] 提交按钮点击成功 (pointer/mousedown→mouseup→click)');
        const submitResult = await submitDetection;
        console.log('[AutoComment] waitForSubmitOrNavigate 结果:', submitResult);
        return {
          success: true,
          button,
          submitResult,
          strategy: 'synthetic-pointer'
        };
      } catch (e) {
        console.log('[AutoComment] 合成事件失败，尝试 button.click()', {
          errorCode: 'synthetic_click_failed'
        });
        try {
          await globalThis.AutoCommentReportBatchDiagnostic?.(
            _batchCtx,
            'submission_strategy_selected',
            { strategy: 'button-click' }
          );
          button.click();
          recordFormSubmit();
          console.log('[AutoComment] button.click() 点击成功');
          const submitResult = await submitDetection;
          console.log('[AutoComment] waitForSubmitOrNavigate 结果:', submitResult);
          return {
            success: true,
            button,
            submitResult,
            strategy: 'button-click'
          };
        } catch (e2) {
          console.log('[AutoComment] button.click() 也失败', {
            errorCode: 'button_click_failed'
          });

          if (await tryRequestSubmit(formEl, button)) {
            recordFormSubmit();
            console.log('[AutoComment] form.requestSubmit(submitter) 成功');
            const submitResult = await submitDetection;
            console.log('[AutoComment] waitForSubmitOrNavigate 结果:', submitResult);
            return {
              success: true,
              button,
              submitResult,
              strategy: 'request-submit'
            };
          }
          try {
            if (formEl) {
              await globalThis.AutoCommentReportBatchDiagnostic?.(
                _batchCtx,
                'submission_strategy_selected',
                { strategy: 'form-submit' }
              );
              console.log('[AutoComment] 降级 form.submit()（无 submit 事件）');
              formEl.submit();
              recordFormSubmit();
              const submitResult = await submitDetection;
              console.log('[AutoComment] waitForSubmitOrNavigate 结果:', submitResult);
              return {
                success: true,
                button,
                submitResult,
                strategy: 'form-submit'
              };
            }
          } catch (e3) {
            console.log('[AutoComment] 表单提交也失败', {
              errorCode: 'form_submit_failed'
            });
          }

          return { success: false, error: '点击按钮失败: ' + e2.message };
        }
      }
    } catch (e) {
      console.log('[AutoComment] 直接点击失败', {
        errorCode: 'direct_click_failed'
      });

      try {
        await globalThis.AutoCommentReportBatchDiagnostic?.(
          _batchCtx,
          'submission_strategy_selected',
          { strategy: 'dispatch-click' }
        );
        const event = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true
        });
        button.dispatchEvent(event);
        recordFormSubmit();
        console.log('[AutoComment] 使用 dispatchEvent 点击成功');
        const submitResult = await submitDetection;
        console.log('[AutoComment] waitForSubmitOrNavigate 结果:', submitResult);
        return {
          success: true,
          button,
          submitResult,
          strategy: 'dispatch-click'
        };
      } catch (e2) {
        console.log('[AutoComment] dispatchEvent 点击也失败', {
          errorCode: 'dispatch_click_failed'
        });

        if (await tryRequestSubmit(formEl, button)) {
          recordFormSubmit();
          console.log('[AutoComment] form.requestSubmit(submitter) 成功');
          const submitResult = await submitDetection;
          console.log('[AutoComment] waitForSubmitOrNavigate 结果:', submitResult);
          return {
            success: true,
            button,
            submitResult,
            strategy: 'request-submit'
          };
        }
        try {
          if (formEl) {
            await globalThis.AutoCommentReportBatchDiagnostic?.(
              _batchCtx,
              'submission_strategy_selected',
              { strategy: 'form-submit' }
            );
            console.log('[AutoComment] 尝试 form.submit()');
            formEl.submit();
            recordFormSubmit();
            const submitResult = await submitDetection;
            console.log('[AutoComment] waitForSubmitOrNavigate 结果:', submitResult);
            return {
              success: true,
              button,
              submitResult,
              strategy: 'form-submit'
            };
          }
        } catch (e3) {
          console.log('[AutoComment] 表单提交失败', {
            errorCode: 'form_submit_failed'
          });
        }

        return { success: false, error: '点击按钮失败: ' + e.message };
      }
    }
  }

  function tryFillCommentTextareaWithPromotion(promotionText) {
    if (!promotionText) {
      console.log('[AutoComment] 没有推广文案可填充');
      return false;
    }

    const targetTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (!targetTextarea) {
      console.log('[AutoComment] 未找到评论文本框，无法填充文案');
      return false;
    }

    console.log('[AutoComment] 找到评论文本框:', {
      name: targetTextarea.name,
      id: targetTextarea.id,
      className: targetTextarea.className,
      filled: Boolean(targetTextarea.value),
      currentLength: targetTextarea.value?.length || 0
    });

    // 如果文本框已有内容，可以选择覆盖或跳过
    const currentValue = (targetTextarea.value || '').trim();
    // 如果当前文本与缓存文案相同，说明已填充过，直接跳过
    if (currentValue === promotionText) {
      console.log('[AutoComment] 文本框内容已与缓存文案一致，跳过');
      return false;
    }
    // 如果文本框有内容但与缓存文案不同（可能是页面刷新后回填了旧评论内容），
    // 则用缓存文案覆盖
    if (currentValue && currentValue !== promotionText) {
      console.log('[AutoComment] 文本框内容与缓存文案不一致，将用缓存覆盖旧内容');
    }

    setValueRobust(targetTextarea, promotionText);
    console.log('[AutoComment] 成功填入推广文案，长度:', promotionText.length);
    return true;
  }

  async function findCommentTargetsForBatchUsingManualFlow(timeoutMs = 12000) {
    const start = Date.now();
    let hasTriggeredFlow = false;
    let lastForm = null;
    let lastTextarea = null;

    while (Date.now() - start < timeoutMs) {
      lastForm = findCommentForm();
      lastTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });

      if (lastForm && lastTextarea) {
        console.log('[content] BATCH_HANDLE 手动按钮同款找框成功:', {
          formId: lastForm.id,
          formClass: lastForm.className,
          textareaName: lastTextarea.name,
          textareaId: lastTextarea.id
        });
        return { form: lastForm, textarea: lastTextarea };
      }

      if (!hasTriggeredFlow) {
        hasTriggeredFlow = true;
        console.log('[content] BATCH_HANDLE 使用手动按钮同款流程触发评论表单展开...');
        await triggerCommentFormFlow();
      }

      await new Promise(resolve => setTimeout(resolve, 800));
    }

    console.log('[content] BATCH_HANDLE 手动按钮同款找框超时:', {
      hasForm: !!lastForm,
      hasTextarea: !!lastTextarea
    });
    return { form: lastForm, textarea: lastTextarea };
  }

  function focusCommentTextareaWithPromotion(promotionText) {
    const targetTextarea = findLikelyCommentTextarea({ allowGenericFallback: true });
    if (!targetTextarea) {
      console.log('[AutoComment] 未找到评论文本框，无法聚焦');
      return;
    }

    // 如果文本框为空且有推广文案，先填入
    const current = (targetTextarea.value || '').trim();
    if (!current && promotionText) {
      setValue(targetTextarea, promotionText);
    }

    try {
      targetTextarea.focus();
      const len = targetTextarea.value.length;
      if (typeof targetTextarea.setSelectionRange === 'function') {
        targetTextarea.setSelectionRange(len, len);
      }
      if (typeof targetTextarea.scrollIntoView === 'function') {
        targetTextarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (e) {
      console.log('[AutoComment] 聚焦文本框失败', {
        errorCode: 'editor_focus_failed'
      });
    }
  }

  // ============================================================
  //  确保评论表单所有必填字段都被正确填入，并在提交前验证
  // ============================================================
  async function ensureAllCommentFormFieldsFilled(
    commentText,
    skipCommentValidation = false,
    reportStatus
  ) {
    const userProfile = await getUserProfile();
    const WEBSITE = await getWebsiteUrl();
    const USERNAME = userProfile.name || '';
    const EMAIL = userProfile.email || '';

    console.log('[AutoComment] ===== ensureAllCommentFormFieldsFilled 开始 =====');
    console.log('[AutoComment] 评论字段配置已加载:', {
      hasName: Boolean(USERNAME),
      hasEmail: Boolean(EMAIL),
      hasWebsite: Boolean(WEBSITE),
      skipComment: skipCommentValidation
    });

    // ── 前置检查：配置缺失则直接报错，不静默失败 ─────────────────
    if (!USERNAME || !EMAIL) {
      const missing = [];
      if (!USERNAME) missing.push('姓名（Name）');
      if (!EMAIL) missing.push('邮箱（Email）');
      const msg = '请先在扩展选项页填写' + missing.join('和') + '，否则无法自动提交评论！';
      console.error('[AutoComment] ' + msg);
      if (typeof reportStatus === 'function') {
        reportStatus(msg, '#f97373');
      }
      return {
        success: false,
        missingFields: [
          ...(!USERNAME ? ['name config missing'] : []),
          ...(!EMAIL ? ['email config missing'] : [])
        ]
      };
    }

    // ── 步骤1：找到表单 ──────────────────────────────────────
    let form = null;

    // 方法A：直接用 WordPress 标准 form 选择器
    const formSelectors = [
      '#commentform',
      '.comment-form',
      '.commentform',
      'form[name="commentform"]',
      'form[id="commentform"]',
      'form[class*="comment-form"]',
      'form[id*="comment-form"]'
    ];
    for (const sel of formSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.tagName === 'FORM') {
          form = el;
          console.log('[AutoComment] 通过选择器找到表单:', sel);
          break;
        }
      } catch (_) {}
    }

    // 方法B：先找 textarea，再用 ta.form / closest('form')
    if (!form) {
      const textarea = findLikelyCommentTextarea({ allowGenericFallback: true });
      if (textarea) {
        console.log('[AutoComment] 找到评论 textarea:', {
          name: textarea.name,
          id: textarea.id,
          className: textarea.className,
          tagName: textarea.tagName,
          formAttr: textarea.form ? textarea.form.id || textarea.form.className : 'null'
        });
        // textarea.form 在大多数现代浏览器中会返回关联的表单元素
        if (textarea.form) {
          form = textarea.form;
          console.log('[AutoComment] 通过 textarea.form 找到表单');
        } else if (textarea.closest) {
          const parentForm = textarea.closest('form');
          if (parentForm) {
            form = parentForm;
            console.log('[AutoComment] 通过 textarea.closest("form") 找到表单');
          }
        }
      }
    }

    // 方法C：在评论区域附近找 form
    if (!form) {
      const areaSelectors = [
        '#comments', '#respond', '.comment-respond',
        '#comments-section', '.comments-area', '.comment-section'
      ];
      for (const sel of areaSelectors) {
        const area = document.querySelector(sel);
        if (area) {
          const f = area.querySelector('form') || (area.closest ? area.closest('form') : null);
          if (f) {
            form = f;
            console.log('[AutoComment] 通过评论区域找到表单:', sel);
            break;
          }
        }
      }
    }

    // 方法D：直接找页面所有表单中含 comment/respond 关键词的
    if (!form) {
      const allForms = Array.from(document.querySelectorAll('form'));
      for (const f of allForms) {
        const text = (f.textContent || '').toLowerCase();
        const cls = (f.className || '').toLowerCase();
        const fid = (f.id || '').toLowerCase();
        if (text.includes('comment') || text.includes('respond') ||
            cls.includes('comment') || fid.includes('comment') ||
            cls.includes('respond') || fid.includes('respond')) {
          form = f;
          console.log('[AutoComment] 通过关键词找到表单:', f.id, f.className);
          break;
        }
      }
    }

    if (!form) {
      console.log('[AutoComment] 未能找到评论表单!');
      return { success: false, missingFields: ['form not found'] };
    }

    console.log('[AutoComment] 最终使用的表单:', {
      id: form.id,
      className: form.className,
      action: form.action
    });

    // ── 步骤2：统计表单中所有输入框（用于日志）───────────────
    const formAllInputs = Array.from(form.querySelectorAll('input'));
    const formTextareas = Array.from(form.querySelectorAll('textarea'));
    const passwordInputs = formAllInputs.filter(
      (input) => (input.type || '').toLowerCase() === 'password'
    );
    if (passwordInputs.length > 0) {
      const passwordProfile = await getUserProfile({ includePassword: true });
      if (passwordProfile.password) {
        for (const passwordInput of passwordInputs) {
          setValueRobust(passwordInput, passwordProfile.password);
        }
      }
    }
    console.log('[AutoComment] 表单中的 input 数量:', formAllInputs.length, 'textarea 数量:', formTextareas.length);
    console.log('[AutoComment] 表单中所有 input:', formAllInputs.map(i => ({
      name: i.name, id: i.id, type: i.type, className: i.className,
      placeholder: i.placeholder, valueLen: (i.value || '').length
    })));

    // ── 步骤3：找评论 textarea ───────────────────────────────
    let commentTextarea = null;
    if (formTextareas.length > 0) {
      // 优先找有 comment 关键词的
      commentTextarea = formTextareas.find(ta => {
        const n = (ta.name || '').toLowerCase();
        const i = (ta.id || '').toLowerCase();
        return n.includes('comment') || i.includes('comment');
      }) || formTextareas[0];
    }
    if (!commentTextarea) {
      // 再从全局找并验证属于当前表单
      const ta = findLikelyCommentTextarea({ allowGenericFallback: true });
      if (ta && (ta.form === form || (ta.closest && ta.closest('form') === form))) {
        commentTextarea = ta;
      }
    }

    if (!commentTextarea) {
      console.log('[AutoComment] 未找到评论 textarea!');
      return { success: false, missingFields: ['comment textarea not found'] };
    }

    // ── 步骤4：找 Name 输入框 ─────────────────────────────────
    // 直接选择器 + closest 验证（不依赖 formInputs 集合，避免遗漏嵌套字段）
    let nameInput = null;
    const nameSelectors = [
      '#author', 'input[name="author"]',
      'input[id*="author" i]', 'input[class*="author" i]',
      'input[name="name"]', 'input[name="your-name"]',
      'input[id="name"]', 'input[id="author-name"]',
      'input[placeholder*="name" i]', 'input[placeholder*="姓名" i]',
      'input[placeholder*="昵称" i]', 'input[placeholder*="名字" i]'
    ];
    for (const sel of nameSelectors) {
      try {
        const el = form.querySelector(sel);
        if (el && el.tagName === 'INPUT' && el.closest('form') === form) {
          nameInput = el;
          console.log('[AutoComment] 通过选择器找到 nameInput:', sel, { name: nameInput.name, id: nameInput.id, type: nameInput.type });
          break;
        }
      } catch (_) {}
    }
    if (nameInput) {
      console.log('[AutoComment] 找到 nameInput:', { name: nameInput.name, id: nameInput.id, type: nameInput.type });
    } else {
      console.log('[AutoComment] 未找到 nameInput!');
    }

    // ── 步骤5：找 Email 输入框 ───────────────────────────────
    let emailInput = null;
    const emailSelectors = [
      '#email', 'input[name="email"]', 'input[type="email"]',
      'input[id="mail"]', 'input[name="mail"]',
      'input[id*="email" i]', 'input[class*="email" i]',
      'input[name="your-email"]', 'input[name="your_mail"]',
      'input[placeholder*="email" i]', 'input[placeholder*="邮箱" i]',
      'input[placeholder*="mail" i]', 'input[placeholder*="e-mail" i]'
    ];
    for (const sel of emailSelectors) {
      try {
        const el = form.querySelector(sel);
        if (el && el.tagName === 'INPUT' && el.closest('form') === form) {
          emailInput = el;
          console.log('[AutoComment] 通过选择器找到 emailInput:', sel, { name: emailInput.name, id: emailInput.id, type: emailInput.type });
          break;
        }
      } catch (_) {}
    }
    if (emailInput) {
      console.log('[AutoComment] 找到 emailInput:', { name: emailInput.name, id: emailInput.id, type: emailInput.type });
    } else {
      console.log('[AutoComment] 未找到 emailInput!');
    }

    // ── 步骤6：找 Website 输入框 ─────────────────────────────
    let websiteInput = null;
    const urlSelectors = [
      '#url', 'input[name="url"]', 'input[type="url"]',
      'input[id="website"]', 'input[name="website"]',
      'input[placeholder*="website" i]', 'input[placeholder*="网站" i]',
      'input[placeholder*="url" i]'
    ];
    for (const sel of urlSelectors) {
      try {
        const el = form.querySelector(sel);
        if (el && el.tagName === 'INPUT' && el.closest('form') === form) {
          websiteInput = el;
          console.log('[AutoComment] 通过选择器找到 websiteInput:', sel);
          break;
        }
      } catch (_) {}
    }
    if (websiteInput) {
      console.log('[AutoComment] 找到 websiteInput:', { name: websiteInput.name, id: websiteInput.id, type: websiteInput.type });
    } else {
      console.log('[AutoComment] 未找到 websiteInput（可选）');
    }

    // ── 步骤7：填入所有字段 ─────────────────────────────────
    console.log('[AutoComment] 开始填入字段...');

    if (nameInput) {
      setValueRobust(nameInput, USERNAME);
    }
    if (emailInput) {
      setValueRobust(emailInput, EMAIL);
    }
    if (websiteInput && WEBSITE) {
      setValue(websiteInput, WEBSITE);
    }
    if (commentText && commentTextarea) {
      // 检测是否是 wpDiscuz 编辑器
      if (commentTextarea._isWpDiscuz) {
        setValueForEditableDiv(commentTextarea._realElement, commentText);
      } else {
        setValue(commentTextarea, commentText);
      }
    }

    // ── 步骤8：等待 DOM 更新后验证 ───────────────────────────
    await new Promise(resolve => setTimeout(resolve, 150));

    const missingFields = [];
    const validationLog = {};

    // 验证 comment（预检查时跳过，因为文案尚未生成）
    // 注意：如果是 wpDiscuz，需要从 _realElement 获取 textContent
    const cv = commentTextarea._isWpDiscuz 
      ? (commentTextarea._realElement.textContent || '').trim()
      : (commentTextarea.value || '').trim();
    validationLog.comment = { filled: cv.length > 0, length: cv.length, isWpDiscuz: !!commentTextarea._isWpDiscuz };
    if (!skipCommentValidation && (!cv || cv.length < 5)) {
      missingFields.push('comment');
    }

    // 验证 name（某些网站不强制要求姓名，不影响提交）
    if (nameInput) {
      const nv = (nameInput.value || '').trim();
      validationLog.name = { filled: nv.length > 0, length: nv.length };
    } else {
      validationLog.name = { found: false, optional: true };
    }

    // 验证 email（某些网站（如 Jetpack、Disqus）不强制要求邮箱，不影响提交）
    if (emailInput) {
      const ev = (emailInput.value || '').trim();
      validationLog.email = { filled: ev.length > 0, length: ev.length };
    } else {
      validationLog.email = { found: false, optional: true };
    }

    // 验证 website（可选，不影响提交）
    if (websiteInput) {
      validationLog.website = { filled: !!(websiteInput.value || '').trim() };
    }

    console.log('[AutoComment] 字段验证结果:', validationLog);
    console.log('[AutoComment] 缺失字段:', missingFields);
    console.log('[AutoComment] ===== ensureAllCommentFormFieldsFilled 结束 =====');

    return { success: missingFields.length === 0, missingFields };
  }

  // 收集当前页面内容，再由后台服务生成推广文案。
  async function generatePromotionCopyWithLlm() {
    const systemPrompt = await getQwenSkillTemplate();
    const websiteUrl = window.location.href || '';
    const title = document.title || '';
    const descriptionMeta =
      document.querySelector('meta[name="description"]') ||
      document.querySelector('meta[name="Description"]');
    const description = descriptionMeta ? descriptionMeta.content || '' : '';

    const bodyText = document.body ? document.body.innerText || '' : '';
    const userPrompt = globalThis.AutoCommentLlmBridge.buildPageUserPrompt({
      websiteUrl,
      title,
      description,
      bodyText
    });
    return globalThis.AutoCommentLlmBridge.generate(chrome.runtime, { systemPrompt, userPrompt });
  }

  // ====== 页面内浮动窗口 UI ======
  let qwenPanelEl = null;

  function createOrToggleQwenPanel() {
    if (qwenPanelEl && qwenPanelEl.parentNode) {
      qwenPanelEl.parentNode.removeChild(qwenPanelEl);
      qwenPanelEl = null;
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'auto-register-qwen-panel';
    panel.style.position = 'fixed';
    panel.style.right = '24px';
    panel.style.bottom = '24px';
    panel.style.width = '360px';
    panel.style.maxWidth = '80vw';
    panel.style.maxHeight = '60vh';
    panel.style.zIndex = '2147483647';
    panel.style.background = 'rgba(15,23,42,0.97)';
    panel.style.color = '#e5e7eb';
    panel.style.borderRadius = '12px';
    panel.style.boxShadow = '0 18px 45px rgba(15,23,42,0.55)';
    panel.style.backdropFilter = 'blur(14px)';
    panel.style.fontFamily =
      "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,'Open Sans','Helvetica Neue',sans-serif";
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.overflow = 'hidden';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.padding = '10px 14px';
    header.style.borderBottom = '1px solid rgba(148,163,184,0.25)';
    header.style.fontSize = '13px';
    header.style.fontWeight = '600';
    header.textContent = 'AI · 网站推广助手';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.border = 'none';
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = '#9ca3af';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '16px';
    closeBtn.style.lineHeight = '1';
    closeBtn.style.padding = '2px 4px';
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#e5e7eb'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#9ca3af'; });
    closeBtn.addEventListener('click', () => {
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      qwenPanelEl = null;
    });

    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.style.padding = '10px 12px 12px';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '8px';
    body.style.fontSize = '12px';

    const hint = document.createElement('div');
    hint.textContent = '基于当前网页内容，一键生成推广文案。';
    hint.style.color = '#9ca3af';
    hint.style.lineHeight = '1.4';

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.alignItems = 'center';
    btnRow.style.gap = '8px';

    const generateBtn = document.createElement('button');
    generateBtn.textContent = 'AI生成推广文案';
    generateBtn.style.flex = '1';
    generateBtn.style.border = 'none';
    generateBtn.style.borderRadius = '999px';
    generateBtn.style.padding = '7px 12px';
    generateBtn.style.fontSize = '12px';
    generateBtn.style.fontWeight = '500';
    generateBtn.style.cursor = 'pointer';
    generateBtn.style.background = 'linear-gradient(135deg, #2563eb, #4f46e5)';
    generateBtn.style.color = '#f9fafb';
    generateBtn.style.boxShadow = '0 10px 24px rgba(37,99,235,0.45)';
    generateBtn.addEventListener('mouseenter', () => {
      if (!generateBtn.disabled) generateBtn.style.filter = 'brightness(1.05)';
    });
    generateBtn.addEventListener('mouseleave', () => { generateBtn.style.filter = 'none'; });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制文案';
    copyBtn.style.border = 'none';
    copyBtn.style.borderRadius = '999px';
    copyBtn.style.padding = '7px 10px';
    copyBtn.style.fontSize = '12px';
    copyBtn.style.cursor = 'pointer';
    copyBtn.style.background = 'rgba(15,23,42,0.8)';
    copyBtn.style.color = '#e5e7eb';
    copyBtn.style.border = '1px solid rgba(148,163,184,0.6)';
    copyBtn.disabled = true;
    copyBtn.style.opacity = '0.55';

    const statusEl = document.createElement('div');
    statusEl.style.minHeight = '16px';
    statusEl.style.fontSize = '11px';
    statusEl.style.color = '#9ca3af';

    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.style.width = '100%';
    textarea.style.flex = '1';
    textarea.style.minHeight = '120px';
    textarea.style.maxHeight = '220px';
    textarea.style.borderRadius = '8px';
    textarea.style.border = '1px solid rgba(148,163,184,0.6)';
    textarea.style.background = 'rgba(15,23,42,0.85)';
    textarea.style.color = '#e5e7eb';
    textarea.style.fontSize = '12px';
    textarea.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    textarea.style.padding = '8px 9px';
    textarea.style.boxSizing = 'border-box';
    textarea.style.resize = 'vertical';

    btnRow.appendChild(generateBtn);
    btnRow.appendChild(copyBtn);

    body.appendChild(hint);
    body.appendChild(btnRow);
    body.appendChild(statusEl);
    body.appendChild(textarea);

    panel.appendChild(header);
    panel.appendChild(body);

    document.documentElement.appendChild(panel);
    qwenPanelEl = panel;

    qwenPanelEl._qwenTextarea = textarea;
    qwenPanelEl._qwenSetStatus = setStatus;
    qwenPanelEl._qwenSetCopyEnabled = setCopyEnabled;
    qwenPanelEl._qwenSetGenerateLoading = setGenerateLoading;

    if (lastGeneratedPromotionCopy) {
      textarea.value = lastGeneratedPromotionCopy;
      setCopyEnabled(true);
      setStatus('已自动生成推广文案，可以复制使用。', '#22c55e');
    }

    function setStatus(text, color) {
      statusEl.textContent = text || '';
      if (color) statusEl.style.color = color;
    }

    function setCopyEnabled(enabled) {
      copyBtn.disabled = !enabled;
      copyBtn.style.opacity = enabled ? '1' : '0.55';
    }

    function setGenerateLoading(loading) {
      if (loading) {
        generateBtn.disabled = true;
        generateBtn.style.opacity = '0.55';
        generateBtn.style.cursor = 'not-allowed';
        generateBtn.style.background = '#4b5563';
        generateBtn.style.boxShadow = 'none';
        generateBtn.textContent = '生成中…';
      } else {
        generateBtn.disabled = false;
        generateBtn.style.opacity = '1';
        generateBtn.style.cursor = 'pointer';
        generateBtn.style.background = 'linear-gradient(135deg, #2563eb, #4f46e5)';
        generateBtn.style.boxShadow = '0 10px 24px rgba(37,99,235,0.45)';
        generateBtn.textContent = 'AI生成推广文案';
      }
    }

    generateBtn.addEventListener('click', async () => {
      setStatus('正在生成推广文案，请稍候…', '#9ca3af');
      textarea.value = '';
      setCopyEnabled(false);
      setGenerateLoading(true);
      try {
        if (_batchCtx) {
          await reportBatchPhase(_batchCtx, 'generating');
        }
        const text = await generatePromotionCopyWithLlm();
        lastGeneratedPromotionCopy = text;
        textarea.value = text;
        await recordGenerationTime(text);

        // ── 把文案填入页面评论框 ────────────────────────────────────
        console.log('[AutoComment] >>>[0] 即将调用 tryFillCommentTextareaWithPromotion');
        if (_batchCtx) {
          await reportBatchPhase(_batchCtx, 'filling');
        }
        const filled = tryFillCommentTextareaWithPromotion(text);
        console.log('[AutoComment] >>>[1] tryFillCommentTextareaWithPromotion 返回:', filled);
        if (!filled) {
          console.log('[AutoComment] 页面评论框填充未成功（可能已有内容或未找到文本框）');
        }

        // ── 步骤A：读取用户配置 ─────────────────────────────────
        console.log('[AutoComment] >>>[2] 即将调用 getUserProfile...');
        const userProfile = await getUserProfile();
        console.log('[AutoComment] >>>[3] Profile 配置已加载');

        console.log('[AutoComment] >>>[4] 检查用户配置是否完整...');
        if (!userProfile.name || !userProfile.email) {
          const missing = [];
          if (!userProfile.name) missing.push('姓名（Name）');
          if (!userProfile.email) missing.push('邮箱（Email）');
          const msg = '请先在扩展选项页填写' + missing.join('和') + '，否则无法自动提交评论！';
          setStatus(msg, '#f97373');
          console.error('[AutoComment] ' + msg);
          setCopyEnabled(true);
          setGenerateLoading(false);
          return;
        }
        console.log('[AutoComment] >>>[5] 用户配置检查通过，继续执行...');

        setCopyEnabled(true);

        // === 自动提交评论（全自动，无需手动点击任何按钮）===
        console.log('[AutoComment] >>>[6] 即将调用 getAutoSubmitCommentSetting...');
        const shouldAutoSubmit = await getAutoSubmitCommentSetting();
        console.log('[AutoComment] shouldAutoSubmit =', shouldAutoSubmit);

        console.log('[AutoComment] >>>[7] shouldAutoSubmit 检查完成，开始判断...');
        if (shouldAutoSubmit) {
          console.log('[AutoComment] >>>[8] shouldAutoSubmit 为 true，准备自动提交...');
          setStatus('正在自动提交评论，请稍候…', '#9ca3af');

          // 确保所有表单字段都已填好，再点击提交按钮
          const fillResult = await ensureAllCommentFormFieldsFilled(
            text,
            false,
            setStatus
          );

          if (!fillResult.success) {
            const msg = '以下字段缺失，无法自动提交：' + fillResult.missingFields.join('、');
            setStatus(msg + '，请手动检查', '#f97373');
            console.error('[AutoComment] 自动提交跳过 - 字段缺失:', fillResult.missingFields);
            setGenerateLoading(false);
            return;
          }

          const submitButton = findCommentSubmitButton();
          if (!submitButton) {
            setStatus('未找到提交按钮，请手动提交', '#f59e0b');
            setGenerateLoading(false);
            return;
          }

          if (!isButtonClickable(submitButton)) {
            setStatus('提交按钮不可见，请手动检查', '#f59e0b');
            setGenerateLoading(false);
            return;
          }

          // 等待一小段时间确保页面 JS 验证逻辑已完成初始化
          await new Promise(resolve => setTimeout(resolve, 600));

          const editor = findLikelyCommentTextarea({ allowGenericFallback: true });
          const history = await captureCurrentCommentHistory(editor, location.href);
          if (_batchCtx) {
            const { batchId, urlIndex, attempt, url } = _batchCtx;
            await persistBatchSubmitContext(
              batchId,
              urlIndex,
              attempt,
              url,
              'success',
              text,
              null,
              history
            );
            try {
              await reportBatchPhase(_batchCtx, 'submitting');
            } catch (error) {
              await clearBatchSubmitContext({
                batchId,
                urlIndex,
                attempt
              });
              throw error;
            }
            await markBatchTaskSubmitting(batchId, urlIndex, attempt);
          }
          const result = await clickCommentSubmitButton();
          if (result.success) {
            const submissionConfirmation =
              await confirmDispatchedSubmissionResult(
                result.submitResult || 'timeout'
              );
            if (submissionConfirmation.navigationPending) {
              setStatus('页面正在跳转，等待服务器确认评论…', '#9ca3af');
              return;
            }
            if (!submissionConfirmation.confirmed) {
              const message = submissionConfirmation.reason
                || '未能确认服务器已接受评论';
              if (_batchCtx) {
                await writePendingResult(
                  _batchCtx.batchId,
                  _batchCtx.urlIndex,
                  _batchCtx.attempt,
                  _batchCtx.url,
                  'manual_required',
                  null,
                  message,
                  'submission_uncertain'
                );
                await confirmBatchHistoryDurably({
                  type: 'BATCH_HANDLE_CONFIRM',
                  batchId: _batchCtx.batchId,
                  taskId: _batchCtx.taskId,
                  urlIndex: _batchCtx.urlIndex,
                  profileId: _batchCtx.profileId,
                  promotionSiteId: _batchCtx.promotionSiteId,
                  attempt: _batchCtx.attempt,
                  url: _batchCtx.url || '',
                  aiContent: '',
                  result: 'manual_required',
                  errorCode: 'submission_uncertain',
                  errorMessage: message
                });
              }
              setStatus(`提交结果待确认：${message}`, '#f59e0b');
              return;
            }
            if (_batchCtx) {
              await reportBatchPhase(_batchCtx, 'confirming');
            }
            setStatus('服务器已确认评论提交！', '#22c55e');
            // 批处理模式：提交成功后上报结果到 batch.html
            if (_batchCtx) {
              await reportSuccessToBatch(text, history);
            }
          } else {
            if (_batchCtx) {
              clearBatchSubmitContext({
                batchId: _batchCtx.batchId,
                urlIndex: _batchCtx.urlIndex,
                attempt: _batchCtx.attempt
              });
            }
            setStatus('自动提交失败：' + (result.error || '未知错误') + '，请手动提交', '#f97373');
          }
        console.log('[AutoComment] >>>[7b] shouldAutoSubmit 为 false，仅填充文案');
        } else {
          // 未开启自动提交，仅填充文案并高亮提交按钮
          console.log('[AutoComment] >>>[9] 未开启自动提交，仅填充文案并高亮按钮...');
          setStatus('生成完成！文案已填入评论框，勾选"自动提交"即可全自动发送', '#22c55e');

          const submitButton = findCommentSubmitButton();
          if (submitButton) {
            console.log('[AutoComment] >>>[10] 找到提交按钮，高亮显示...');
            submitButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
            submitButton.style.outline = '3px solid #22c55e';
            submitButton.style.outlineOffset = '2px';
            setTimeout(() => {
              submitButton.style.outline = '';
              submitButton.style.outlineOffset = '';
            }, 3000);
          } else {
            console.log('[AutoComment] >>>[11] 未找到提交按钮');
          }
        }
        setGenerateLoading(false);
      } catch (err) {
        const msg = (err && err.message) || '生成失败，请检查控制台日志。';
        setStatus(msg, '#f97373');
        setCopyEnabled(false);
        setGenerateLoading(false);
      }
    });

    copyBtn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) return;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const temp = document.createElement('textarea');
          temp.value = text;
          temp.style.position = 'fixed';
          temp.style.left = '-9999px';
          document.body.appendChild(temp);
          temp.select();
          document.execCommand('copy');
          document.body.removeChild(temp);
        }
        setStatus('文案已复制到剪贴板。', '#22c55e');
      } catch (err) {
        setStatus('复制失败，请手动选择文本复制。', '#f97373');
      }
    });

    // ====== 外链分析功能 ======
    function analyzeOutlinks() {
      const links = Array.from(document.querySelectorAll('a[href]'));

      const outlinks = links
        .map(link => {
          const href = link.href;
          try {
            const url = new URL(href);
            if (url.protocol === 'mailto:' ||
                url.protocol === 'tel:' ||
                url.protocol === 'javascript:' ||
                href.startsWith('#')) {
              return null;
            }
            // 过滤协议和同站链接
            const currentHost = window.location.hostname;
            const currentDomain = currentHost.replace(/^www\./, '');
            const linkDomain = url.hostname.replace(/^www\./, '');
            if (linkDomain === currentDomain) {
              return null;
            }
            const rel = (link.rel || '').toLowerCase();
            const isNofollow = rel.includes('nofollow');

            return {
              url: href,
              text: link.textContent?.trim() || link.innerText?.trim() || '',
              host: url.hostname,
              isNofollow,
              isDofollow: !isNofollow
            };
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);

      const seen = new Set();
      return outlinks.filter(link => {
        if (seen.has(link.url)) return false;
        seen.add(link.url);
        return true;
      });
    }

    function showOutlinksPanel() {
      const existing = document.getElementById('auto-comment-outlinks-panel');
      if (existing) existing.remove();

      const outlinks = analyzeOutlinks();
      const dofollowCount = outlinks.filter(l => l.isDofollow).length;
      const nofollowCount = outlinks.filter(l => l.isNofollow).length;

      const panel = document.createElement('div');
      panel.id = 'auto-comment-outlinks-panel';
      panel.style.position = 'fixed';
      panel.style.left = '50%';
      panel.style.top = '50%';
      panel.style.transform = 'translate(-50%, -50%)';
      panel.style.width = '600px';
      panel.style.maxWidth = '90vw';
      panel.style.maxHeight = '80vh';
      panel.style.zIndex = '2147483647';
      panel.style.background = 'rgba(15,23,42,0.98)';
      panel.style.color = '#e5e7eb';
      panel.style.borderRadius = '12px';
      panel.style.boxShadow = '0 18px 45px rgba(15,23,42,0.55)';
      panel.style.fontFamily = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
      panel.style.display = 'flex';
      panel.style.flexDirection = 'column';
      panel.style.overflow = 'hidden';

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.justifyContent = 'space-between';
      header.style.padding = '12px 16px';
      header.style.borderBottom = '1px solid rgba(148,163,184,0.25)';

      const title = document.createElement('div');
      title.style.fontSize = '14px';
      title.style.fontWeight = '600';
      title.textContent = `外链分析 - 共 ${outlinks.length} 个`;

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.border = 'none';
      closeBtn.style.background = 'transparent';
      closeBtn.style.color = '#9ca3af';
      closeBtn.style.cursor = 'pointer';
      closeBtn.style.fontSize = '18px';
      closeBtn.addEventListener('click', () => panel.remove());

      header.appendChild(title);
      header.appendChild(closeBtn);

      const stats = document.createElement('div');
      stats.style.display = 'flex';
      stats.style.gap = '16px';
      stats.style.padding = '10px 16px';
      stats.style.fontSize = '12px';
      stats.style.borderBottom = '1px solid rgba(148,163,184,0.15)';

      const dofollowStat = document.createElement('span');
      dofollowStat.innerHTML = `<span style="color:#22c55e;font-weight:600">✓ DoFollow:</span> ${dofollowCount}`;
      const nofollowStat = document.createElement('span');
      nofollowStat.innerHTML = `<span style="color:#f97373;font-weight:600">✗ NoFollow:</span> ${nofollowCount}`;

      stats.appendChild(dofollowStat);
      stats.appendChild(nofollowStat);

      const list = document.createElement('div');
      list.style.flex = '1';
      list.style.overflowY = 'auto';
      list.style.padding = '8px';

      if (outlinks.length === 0) {
        list.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:20px">未检测到外链</div>';
      } else {
        outlinks.forEach(link => {
          const item = document.createElement('div');
          item.style.display = 'flex';
          item.style.alignItems = 'center';
          item.style.gap = '8px';
          item.style.padding = '6px 8px';
          item.style.borderRadius = '6px';
          item.style.fontSize = '11px';
          item.style.wordBreak = 'break-all';

          const tag = document.createElement('span');
          tag.style.flexShrink = '0';
          tag.style.padding = '2px 6px';
          tag.style.borderRadius = '4px';
          tag.style.fontSize = '10px';
          tag.style.fontWeight = '600';

          if (link.isDofollow) {
            tag.style.background = 'rgba(34,197,94,0.2)';
            tag.style.color = '#22c55e';
            tag.textContent = 'DoFollow';
          } else {
            tag.style.background = 'rgba(249,115,115,0.2)';
            tag.style.color = '#f97373';
            tag.textContent = 'NoFollow';
          }

          const linkEl = document.createElement('a');
          linkEl.href = link.url;
          linkEl.textContent = link.host;
          linkEl.style.color = '#60a5fa';
          linkEl.style.textDecoration = 'none';
          linkEl.style.fontFamily = 'monospace';
          linkEl.target = '_blank';

          item.appendChild(tag);
          item.appendChild(linkEl);
          list.appendChild(item);
        });
      }

      const exportBtn = document.createElement('button');
      exportBtn.textContent = '导出 CSV';
      exportBtn.style.margin = '12px 16px';
      exportBtn.style.padding = '8px 16px';
      exportBtn.style.border = 'none';
      exportBtn.style.borderRadius = '6px';
      exportBtn.style.background = 'linear-gradient(135deg, #2563eb, #4f46e5)';
      exportBtn.style.color = '#fff';
      exportBtn.style.fontSize = '12px';
      exportBtn.style.cursor = 'pointer';
      exportBtn.addEventListener('click', () => {
        const csvHost = window.location.hostname;
        const csvContent = [
          ['URL', 'Hostname', 'Type', 'Link Text'].join(','),
          ...outlinks.map(l => [
            `"${l.url.replace(/"/g, '""')}"`,
            `"${l.host}"`,
            l.isDofollow ? 'DoFollow' : 'NoFollow',
            `"${l.text.replace(/"/g, '""')}"`
          ].join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `outlinks-${csvHost}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      });

      panel.appendChild(header);
      panel.appendChild(stats);
      panel.appendChild(list);
      panel.appendChild(exportBtn);
      document.body.appendChild(panel);
    }

    const outlinkBtn = document.createElement('button');
    outlinkBtn.textContent = '分析外链';
    outlinkBtn.style.border = 'none';
    outlinkBtn.style.borderRadius = '999px';
    outlinkBtn.style.padding = '7px 10px';
    outlinkBtn.style.fontSize = '12px';
    outlinkBtn.style.cursor = 'pointer';
    outlinkBtn.style.background = 'rgba(15,23,42,0.8)';
    outlinkBtn.style.color = '#e5e7eb';
    outlinkBtn.style.border = '1px solid rgba(148,163,184,0.6)';
    outlinkBtn.addEventListener('click', showOutlinksPanel);

    btnRow.appendChild(generateBtn);
    btnRow.appendChild(outlinkBtn);
    btnRow.appendChild(copyBtn);
  }

  // ====== 独立外链导出浮窗按钮 ======
  // 不依赖 AI 面板自动打开设置；批量任务打开博客页时也必须能直接点击并下载 CSV。
  function analyzePageOutlinksForExport() {
    const links = Array.from(document.querySelectorAll('a[href]'));
    const currentHost = window.location.hostname;
    const currentDomain = currentHost.replace(/^www\./, '');

    const outlinks = links
      .map(link => {
        const href = link.href;
        try {
          const url = new URL(href);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
          }

          const linkDomain = url.hostname.replace(/^www\./, '');
          if (linkDomain === currentDomain) {
            return null;
          }

          const rel = (link.rel || '').toLowerCase();
          const isNofollow = rel.includes('nofollow');
          return {
            url: href,
            text: link.textContent?.trim() || link.innerText?.trim() || '',
            host: url.hostname,
            isNofollow,
            isDofollow: !isNofollow
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    const seen = new Set();
    return outlinks.filter(link => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
  }

  function exportPageOutlinksCsv() {
    const outlinks = analyzePageOutlinksForExport();
    const csvHost = window.location.hostname || 'unknown-host';
    const csvContent = [
      ['URL', 'Hostname', 'Type', 'Link Text'].join(','),
      ...outlinks.map(l => [
        `"${String(l.url || '').replace(/"/g, '""')}"`,
        `"${String(l.host || '').replace(/"/g, '""')}"`,
        l.isDofollow ? 'DoFollow' : 'NoFollow',
        `"${String(l.text || '').replace(/"/g, '""')}"`
      ].join(','))
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `outlinks-${csvHost}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('[AutoComment] 已导出外链 CSV:', { host: csvHost, count: outlinks.length });
  }

  function removeOutlinkFloatingButton() {
    const existingBtn = document.getElementById('auto-comment-export-outlinks-btn');
    if (existingBtn) {
      existingBtn.remove();
      console.log('[AutoComment] 独立导出外链浮窗按钮已移除');
    }
  }

  async function applyOutlinkFloatingButtonVisibility(shouldShow) {
    const visible = typeof shouldShow === 'boolean'
      ? shouldShow
      : await getShowExportOutlinksFloatingButtonSetting();
    if (visible) {
      ensureOutlinkFloatingButton();
    } else {
      removeOutlinkFloatingButton();
    }
  }

  function ensureOutlinkFloatingButton() {
    if (document.getElementById('auto-comment-export-outlinks-btn')) {
      return;
    }

    const btn = document.createElement('button');
    btn.id = 'auto-comment-export-outlinks-btn';
    btn.type = 'button';
    btn.textContent = '导出外链';
    btn.setAttribute('data-action', 'analyze-backlinks');
    btn.setAttribute('data-testid', 'analyze-backlinks');
    btn.title = '导出当前页面外链 CSV';
    btn.style.position = 'fixed';
    btn.style.left = '18px';
    btn.style.bottom = '86px';
    btn.style.zIndex = '2147483647';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.minWidth = '88px';
    btn.style.height = '36px';
    btn.style.padding = '0 14px';
    btn.style.border = '1px solid rgba(148,163,184,0.72)';
    btn.style.borderRadius = '999px';
    btn.style.background = 'rgba(15,23,42,0.94)';
    btn.style.color = '#f8fafc';
    btn.style.boxShadow = '0 10px 26px rgba(15,23,42,0.35)';
    btn.style.fontFamily = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
    btn.style.fontSize = '13px';
    btn.style.fontWeight = '600';
    btn.style.lineHeight = '1';
    btn.style.cursor = 'pointer';
    btn.style.whiteSpace = 'nowrap';
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(30,41,59,0.98)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(15,23,42,0.94)';
    });
    btn.addEventListener('click', exportPageOutlinksCsv);

    (document.body || document.documentElement).appendChild(btn);
    console.log('[AutoComment] 独立导出外链浮窗按钮已注入');
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY]) {
        return;
      }
      applyOutlinkFloatingButtonVisibility(changes[SHOW_EXPORT_OUTLINKS_FLOATING_BUTTON_STORAGE_KEY].newValue !== false);
    });
  }

  // 监听 background.js 中点击扩展图标发送的消息
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
      // 就绪检测：batch.js 发 PING 确认 content.js 已注入
      if (message && message.type === 'PING') {
        _sendResponse({
          ok: true,
          documentUrl: location.href,
          readyState: document.readyState
        });
        return;
      }
      if (message && message.type === 'TOGGLE_PROMOTE_PANEL') {
        createOrToggleQwenPanel();
      }
      // 任务接收与实际执行解耦：同步确认，避免长页面流程占用消息通道。
      if (message && message.type === 'BATCH_HANDLE') {
        if (!batchHandleDispatcher) {
          _sendResponse({
            ok: false,
            error: 'batch_handle_dispatch_unavailable',
            urlIndex: message.urlIndex
          });
          return false;
        }
        batchHandleDispatcher.handleMessage(message, _sendResponse);
        return false;
      }
    });
  }

  // ==================== 批量处理任务函数 ====================
  /**
   * 批量模式：自动完成评论流程并上报结果
   */
  function getMetaContent(selector) {
    const el = document.querySelector(selector);
    return el ? (el.getAttribute('content') || '') : '';
  }

  function evaluateCurrentPageForIllegalSite(url) {
    const filter = window.AutoCommentIllegalSiteFilter;
    if (!filter || typeof filter.evaluatePage !== 'function') {
      console.warn('[content] 非法网站过滤器未加载，跳过页面检测');
      return { blocked: false };
    }

    const pageText = document.body ? document.body.innerText : '';
    return filter.evaluatePage(url || location.href, {
      title: document.title || '',
      description: getMetaContent('meta[name="description"], meta[property="og:description"]'),
      keywords: getMetaContent('meta[name="keywords"]'),
      text: pageText
    });
  }

  async function reportIllegalSiteAndClose(
    batchId,
    urlIndex,
    attempt,
    url,
    check
  ) {
    const reason = (check && check.reason) || '非法网站拦截：命中赌博/色情规则';
    console.warn('[content] 检测到非法网站，上报 blocked_illegal 并关闭网页:', {
      batchId,
      urlIndex,
      reasonCode: typeof reason === 'string' ? reason : 'blocked_illegal'
    });
    await writePendingResult(
      batchId,
      urlIndex,
      attempt,
      url,
      'blocked_illegal',
      null,
      reason,
      'illegal_site'
    );

    const confirmation = await confirmBatchHistoryDurably({
      type: 'BATCH_HANDLE_CONFIRM',
      batchId,
      urlIndex,
      attempt,
      url: url || location.href || '',
      aiContent: '',
      result: 'blocked_illegal',
      errorCode: 'illegal_site',
      errorMessage: reason
    });
    console.log(
      '[content] blocked_illegal BATCH_HANDLE_CONFIRM 响应:',
      confirmation.acknowledgement
    );

    setTimeout(() => {
      window.close();
    }, 700);
  }

  async function handleBatchTask(batchId, urlIndex, attempt, url) {
    const context = (
      typeof _batchCtx !== 'undefined'
      && _batchCtx
      && _batchCtx.batchId === batchId
      && _batchCtx.urlIndex === urlIndex
      && _batchCtx.attempt === attempt
    ) ? _batchCtx : {
      batchId,
      taskId: `${batchId}:legacy:${urlIndex}`,
      urlIndex,
      profileId: 'default-profile',
      promotionSiteId: 'default-promotion-site',
      attempt,
      url
    };
    console.log('[content] handleBatchTask 开始 >>>', { batchId, taskId: context.taskId, urlIndex, time: new Date().toISOString() });
    const taskKey = getBatchTaskKey(batchId, urlIndex, attempt, context);
    if (runningBatchTaskKey === taskKey) {
      console.warn('[content] handleBatchTask 跳过重复执行:', taskKey);
      return;
    }
    runningBatchTaskKey = taskKey;
    let submissionDispatched = false;
    let diagnosticPhase = 'loading';
    globalThis.AutoCommentReportBatchDiagnostic?.(
      context,
      'task_started',
      {
      phase: diagnosticPhase
      }
    );
    try {
      await reportBatchPhase(context, 'loading');
      console.log('[content] 1/6 等待页面加载...');
      await waitForPageReady();
      const illegalCheck = evaluateCurrentPageForIllegalSite(url);
      if (illegalCheck.blocked) {
        await reportIllegalSiteAndClose(
          batchId,
          urlIndex,
          attempt,
          url,
          illegalCheck
        );
        return;
      }
      if (context.automation?.autoGenerate === false) {
        await reportGeneratedCommentForManualHandling(
          context,
          null,
          null,
          {
            errorCode: 'automation_disabled',
            errorMessage: '此任务已配置为人工处理'
          }
        );
        return;
      }
      console.log('[content] 2/6 检查是否已处理过...');
      const existingResult = await checkExistingBatchResult(batchId, url, urlIndex);
      if (existingResult) {
        console.log('[content] 该任务已处理过，跳过AI生成', {
          batchId,
          urlIndex,
          result: existingResult?.result || 'existing'
        });
        await reportAlreadyCommented(
          batchId,
          urlIndex,
          attempt,
          url,
          existingResult.aiContent
        );
        return;
      }
      console.log('[content] 3/6 确认评论表单存在...');
      diagnosticPhase = 'detecting';
      await reportBatchPhase(context, 'detecting');
      // 先尝试触发评论表单展开（如果表单是隐藏的需要点击回复链接）
      let form = findCommentForm();
      let ta = findLikelyCommentTextarea({ allowGenericFallback: false });
      if (!form || !ta) {
        console.log('[content] 评论表单未展开，尝试触发展开...');
        await triggerCommentFormFlow();
        // 等待表单展开后再检查
        await new Promise(resolve => setTimeout(resolve, 1500));
        form = findCommentForm();
        ta = findLikelyCommentTextarea({ allowGenericFallback: false });
      }
      // 如果仍然找不到评论框，检测是否有 Disqus，需要额外等待 iframe 加载
      if (!form || !ta) {
        const hasDisqus = document.querySelector('#disqus_thread, [id*="disqus"], iframe[src*="disqus"]');
        if (hasDisqus) {
          console.log('[content] 检测到 Disqus，额外等待 iframe 加载...');
          // 尝试点击展开按钮
          const disqusBtn = document.querySelector('#disqus_thread a, [id*="disqus"] a, .dsq-brlink a, #disqus_thread button');
          if (disqusBtn && !disqusBtn.hasAttribute('data-auto-comment-clicked')) {
            disqusBtn.setAttribute('data-auto-comment-clicked', 'true');
            disqusBtn.click();
          }
          // 等待 Disqus iframe 完全加载（最常需要的时间）
          await new Promise(resolve => setTimeout(resolve, 5000));
          form = findCommentForm();
          ta = findLikelyCommentTextarea({ allowGenericFallback: true });
          if (ta) {
            console.log('[content] Disqus iframe 加载后找到评论框');
          }
        }
      }
      // 最终检查：仍然找不到评论框则先触发流程再继续（与浮窗按钮行为一致）
      if (!form || !ta) {
        console.log('[content] 未找到评论框，尝试触发展开流程...');
        await triggerCommentFormFlow();
        await new Promise(resolve => setTimeout(resolve, 2000));
        form = findCommentForm();
        ta = findLikelyCommentTextarea({ allowGenericFallback: true });
      }
      if (!form || !ta) {
        console.log('[content] 常规批处理找框未完成，切换到手动按钮同款找框逻辑...');
        const manualTargets = await findCommentTargetsForBatchUsingManualFlow(12000);
        form = manualTargets.form;
        ta = manualTargets.textarea;
      }
      globalThis.AutoCommentReportBatchDiagnostic?.(
        context,
        'form_detected',
        {
        phase: diagnosticPhase,
        hasForm: Boolean(form),
        hasTextarea: Boolean(ta)
        }
      );
      // 关键：确认找到评论框后再生成 AI 文案，避免无用请求。
      if (!form || !ta) {
        console.log('[content] 未找到评论框，跳过AI生成，结束任务');
        throw new Error('__NO_COMMENT_BOX__');
      }
      const manualCheckBeforeAi = detectManualRequiredChallenge(form);
      if (manualCheckBeforeAi.found) {
        await reportManualRequiredAndClose(
          batchId,
          urlIndex,
          attempt,
          url,
          null
        );
        return;
      }
      let aiContent = await getCachedPromotionCopy() || lastGeneratedPromotionCopy;
      let generationSource = 'cache';
      if (aiContent) {
        console.log('[content] 4/6 复用已有推广文案，跳过AI生成，长度:', aiContent.length);
      } else {
        console.log('[content] 4/6 生成AI文案...');
        diagnosticPhase = 'generating';
        generationSource = 'llm';
        await reportBatchPhase(context, 'generating');
        aiContent = await generatePromotionCopyWithLlm();
      }
      globalThis.AutoCommentReportBatchDiagnostic?.(
        context,
        'comment_generated',
        {
        phase: diagnosticPhase,
        generationSource,
        contentLength: aiContent?.length || 0
        }
      );
      console.log('[content] AI文案生成完成，长度:', aiContent ? aiContent.length : 0);
      console.log('[content] 5/6 填充表单字段...');
      diagnosticPhase = 'filling';
      await reportBatchPhase(context, 'filling');
      const manualFillResult = tryFillCommentTextareaWithPromotion(aiContent);
      console.log('[content] BATCH_HANDLE 手动按钮同款填充结果:', manualFillResult);
      // AI 生成完成后再次确认评论框存在（表单可能通过3懒加载在生成期间加载好）
      form = findCommentForm();
      ta = findLikelyCommentTextarea({ allowGenericFallback: true });
      if (!form || !ta) {
        console.log('[content] AI生成后未找到评论框，再次触发展开...');
        await triggerCommentFormFlow();
        await new Promise(resolve => setTimeout(resolve, 2000));
        form = findCommentForm();
        ta = findLikelyCommentTextarea({ allowGenericFallback: true });
      }
      if (!form || !ta) {
        console.log('[content] AI生成后常规找框仍未完成，再次使用手动按钮同款找框逻辑...');
        const manualTargets = await findCommentTargetsForBatchUsingManualFlow(12000);
        form = manualTargets.form;
        ta = manualTargets.textarea;
      }
      // 如果 AI 生成后仍然找不到评论框，记录警告但尝试填充（表单可能只是隐藏了）
      if (!form || !ta) {
        console.warn('[content] AI生成后仍未找到评论框，尝试继续填充（表单可能只是隐藏）');
      }
      // 预检查只验证姓名/邮箱/网站字段是否存在，不验证comment（尚未生成）
      const fillResult = await ensureAllCommentFormFieldsFilled('', true);
      if (!fillResult.success) {
        throw new Error('表单字段缺失: ' + (fillResult.missingFields || []).join(', '));
      }
      const refillResult = await ensureAllCommentFormFieldsFilled(aiContent);
      globalThis.AutoCommentReportBatchDiagnostic?.(
        context,
        'form_filled',
        {
        phase: diagnosticPhase,
        success: refillResult.success === true,
        filled: Boolean(
          findLikelyCommentTextarea({ allowGenericFallback: true })?.value
        ),
        contentLength: aiContent?.length || 0,
        missingFieldCount: Array.isArray(refillResult.missingFields)
          ? refillResult.missingFields.length
          : 0
        }
      );
      if (!refillResult.success) {
        throw new Error('表单填充失败: ' + (refillResult.missingFields || []).join(', '));
      }

      const manualCheckBeforeSubmit = detectManualRequiredChallenge(form);
      if (manualCheckBeforeSubmit.found) {
        await reportManualRequiredAndClose(
          batchId,
          urlIndex,
          attempt,
          url,
          aiContent
        );
        return;
      }

      const editor = findLikelyCommentTextarea({ allowGenericFallback: true });
      const history = await captureCurrentCommentHistory(editor, url);
      if (context.automation?.autoSubmit === false) {
        await reportGeneratedCommentForManualHandling(
          context,
          aiContent,
          history
        );
        return;
      }
      // 提交前先写入 pending 结果（页面刷新后 batch.js 仍能立即读到）
      await writePendingResult(
        batchId,
        urlIndex,
        attempt,
        url,
        'success',
        aiContent,
        null,
        null
      );
      await persistBatchSubmitContext(
        batchId,
        urlIndex,
        attempt,
        url,
        'success',
        aiContent,
        null,
        history
      );
      try {
        diagnosticPhase = 'submitting';
        await reportBatchPhase(context, 'submitting');
      } catch (error) {
        await clearBatchSubmitContext({ batchId, urlIndex, attempt });
        throw error;
      }
      await markBatchTaskSubmitting(batchId, urlIndex, attempt);
      console.log('[content] pending结果写入完成');
      console.log('[content] 7/7 点击提交按钮...');
      globalThis.AutoCommentReportBatchDiagnostic?.(
        context,
        'submission_dispatch_started',
        {
        phase: diagnosticPhase
        }
      );
      const clickResult = await clickCommentSubmitButton();
      globalThis.AutoCommentReportBatchDiagnostic?.(
        context,
        'submission_dispatch_result',
        {
        phase: diagnosticPhase,
        success: clickResult.success === true,
        strategy: clickResult.strategy || 'none',
        dispatchResult: clickResult.submitResult || 'not-dispatched'
        }
      );
      console.log('[content] 点击结果:', clickResult);
      if (!clickResult.success) {
        await clearBatchSubmitContext({ batchId, urlIndex, attempt });
        throw new Error(clickResult.error || '提交按钮点击失败');
      }
      submissionDispatched = true;
      diagnosticPhase = 'confirming';
      await reportBatchPhase(context, 'confirming');

      // submit 事件或请求开始都不能确认成功。AJAX 必须等待响应完成并验证页面状态；
      // 原生表单由导航后的新文档恢复 submit context，再确认或标记需人工检查。
      const submitResult = clickResult.submitResult || 'timeout';
      const submissionConfirmation =
        await confirmDispatchedSubmissionResult(submitResult);
      globalThis.AutoCommentReportBatchDiagnostic?.(
        context,
        'submission_confirmation',
        {
        phase: diagnosticPhase,
        confirmed: submissionConfirmation.confirmed === true,
        navigationPending: submissionConfirmation.navigationPending === true,
        confirmationStatus: submissionConfirmation.status || (
          submissionConfirmation.navigationPending ? 'navigation-pending' : 'uncertain'
        ),
        dispatchResult: submitResult
        }
      );
      console.log('[content] 服务器提交确认结果:', {
        confirmed: submissionConfirmation.confirmed,
        navigationPending: submissionConfirmation.navigationPending,
        status: submissionConfirmation.status || null
      });
      if (submissionConfirmation.navigationPending) {
        console.log(
          '[content] 原生表单正在导航；保留提交上下文并由新页面完成确认'
        );
        return;
      }
      if (!submissionConfirmation.confirmed) {
        const error = new Error(submissionConfirmation.reason);
        error.code = submissionConfirmation.status === 'rejected'
          ? 'submission_rejected'
          : 'submission_uncertain';
        throw error;
      }

      // AJAX 已获得服务器响应和页面成功状态后，才通知 background 关闭标签页。
      // 这是关键：即使页面刷新，background 仍持有 batchId，能正确上报
      // 同时等待 background 响应后再返回，使 batch.js 能收到确认再关闭标签页
      console.log('[content] 通知 background (BATCH_HANDLE_CONFIRM)...');
      const confirmation = await confirmBatchHistoryDurably({
        type: 'BATCH_HANDLE_CONFIRM',
        batchId,
        urlIndex,
        attempt,
        url: url || '',
        aiContent,
        errorCode: null,
        history
      });
      console.log('[content] background 响应:', confirmation.acknowledgement);
      console.log('[content] handleBatchTask 完成 <<<', { batchId, urlIndex });
    } catch (err) {
      globalThis.AutoCommentReportBatchDiagnostic?.(
        context,
        'task_error',
        {
        phase: diagnosticPhase,
        errorCode: typeof err?.code === 'string'
          ? err.code
          : (
              err?.message === '__NO_COMMENT_BOX__'
                ? 'no_comment_box'
                : 'batch_task_failed'
            ),
        submissionDispatched
        }
      );
      console.log('[content] handleBatchTask 转入队列错误处理', {
        errorCode: typeof err?.code === 'string'
          ? err.code
          : (
              err?.message === '__NO_COMMENT_BOX__'
                ? 'no_comment_box'
                : 'batch_task_failed'
            )
      });

      // 特殊错误：未找到评论框
      if (err.message === '__NO_COMMENT_BOX__') {
        console.log('[content] 未找到评论框，上报并关闭标签页');
        await writePendingResult(
          batchId,
          urlIndex,
          attempt,
          url,
          'no_comment_box',
          null,
          '未找到评论框',
          'no_comment_box'
        );
        // 使用 BATCH_HANDLE_CONFIRM 触发 background -> batch 的 BATCH_CONFIRMED 流程
        const confirmation = await confirmBatchHistoryDurably({
          type: 'BATCH_HANDLE_CONFIRM',
          batchId,
          urlIndex,
          attempt,
          url: url || '',
          aiContent: '',
          result: 'no_comment_box',
          errorCode: 'no_comment_box',
          errorMessage: '未找到评论框'
        });
        console.log(
          '[content] no_comment_box BATCH_HANDLE_CONFIRM 响应:',
          confirmation.acknowledgement
        );
        // 关闭当前标签页
        setTimeout(() => {
          window.close();
        }, 1000);
        return;
      }
      
      const submissionRejected =
        submissionDispatched && err?.code === 'submission_rejected';
      const errorCode = submissionRejected
        ? 'submission_rejected'
        : submissionDispatched
          ? 'submission_uncertain'
          : 'task_failed';
      if (submissionRejected) {
        const errorMessage = err.message || String(err);
        await writePendingResult(
          batchId,
          urlIndex,
          attempt,
          url,
          'fail',
          null,
          errorMessage,
          errorCode
        );
        await confirmBatchHistoryDurably({
          type: 'BATCH_HANDLE_CONFIRM',
          batchId,
          taskId: context.taskId,
          urlIndex,
          profileId: context.profileId,
          promotionSiteId: context.promotionSiteId,
          attempt,
          url: url || '',
          aiContent: '',
          result: 'fail',
          errorCode,
          errorMessage
        });
        return;
      }
      if (submissionDispatched) {
        const errorMessage = err.message || String(err);
        await writePendingResult(
          batchId,
          urlIndex,
          attempt,
          url,
          'manual_required',
          null,
          errorMessage,
          errorCode
        );
        await confirmBatchHistoryDurably({
          type: 'BATCH_HANDLE_CONFIRM',
          batchId,
          taskId: context.taskId,
          urlIndex,
          profileId: context.profileId,
          promotionSiteId: context.promotionSiteId,
          attempt,
          url: url || '',
          aiContent: '',
          result: 'manual_required',
          errorCode,
          errorMessage
        });
        return;
      }
      await writePendingResult(
        batchId,
        urlIndex,
        attempt,
        url,
        'fail',
        null,
        err.message || String(err),
        errorCode
      );
      await reportBatchResult(
        batchId,
        urlIndex,
        attempt,
        'fail',
        null,
        err.message || String(err),
        url,
        errorCode
      );
      // 不主动关闭窗口，等待超时自动关闭
    } finally {
      if (runningBatchTaskKey === taskKey) {
        runningBatchTaskKey = null;
      }
    }
  }

  /**
   * 等待页面关键元素加载
   */
  function waitForPageReady() {
    return new Promise((resolve) => {
      // 等待评论框或页面加载完毕
      const maxWait = 20000;
      const start = Date.now();
      const check = () => {
        if (Date.now() - start > maxWait) {
          console.log('[content] waitForPageReady 超时，继续执行');
          resolve(); // 超时也继续
          return;
        }
        // 检查是否有评论相关元素（包括 textarea、#respond、评论区域等）
        const hasCommentArea =
          document.querySelector(
            'textarea[name*="comment" i], textarea[name*="reply" i], textarea[name*="message" i], ' +
            'textarea[name*="comentario" i], textarea[name*="comentário" i], ' +
            '#comment, #comments, .comment-form, #respond, .respond, .comment-respond, ' +
            '#comments-area, .comments-area, .comentarios, #comentarios, .comentario, ' +
            '.comment-list, .comment-section, .post-comments-area, ' +
            '[contenteditable="true"][class*="comment"], [contenteditable="true"][class*="comentario"]'
          ) ||
          document.querySelector('form[action*="comment"]');

        // 检测 Disqus 评论系统
        const hasDisqus = document.querySelector(
          '#disqus_thread, [id*="disqus"], iframe[src*="disqus"], .dsq-brlink'
        );

        if (hasDisqus) {
          console.log('[content] waitForPageReady 检测到 Disqus，尝试展开...');
          // 尝试点击 Disqus 展开按钮
          const disqusBtn = document.querySelector(
            '#disqus_thread a, [id*="disqus"] a, .dsq-brlink a, ' +
            '#disqus_thread button, [data-disqus-identifier]'
          );
          if (disqusBtn && !disqusBtn.hasAttribute('data-auto-comment-clicked')) {
            disqusBtn.setAttribute('data-auto-comment-clicked', 'true');
            disqusBtn.click();
            console.log('[content] 已点击 Disqus 展开按钮，等待加载...');
            setTimeout(check, 2000); // 等待 Disqus 加载 iframe
            return;
          }
        }

        if (hasCommentArea) {
          console.log('[content] waitForPageReady 检测到评论区域，等待2秒让JS渲染完');
          setTimeout(resolve, 2000); // 额外等2秒让JS渲染完
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  /**
   * 检查 URL 是否已在 batchResults 中处理过
   */
  async function checkExistingBatchResult(batchId, url, urlIndex) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['batchResults'], (data) => {
        const results = data.batchResults || [];
        // 只要这个 URL 之前成功处理过（不限 batchId），就跳过 AI 生成
        const match = results.find(r => r.url === url && r.result === 'success');
        resolve(match || null);
      });
    });
  }

  /**
   * 上报"已存在评论"状态：跳过 AI 生成，直接写结果并通知 background
   */
  async function reportAlreadyCommented(
    batchId,
    urlIndex,
    attempt,
    url,
    aiContent
  ) {
    await writePendingResult(
      batchId,
      urlIndex,
      attempt,
      url,
      'skipped',
      aiContent,
      'already_commented',
      null
    );
    await confirmBatchHistoryDurably({
      type: 'BATCH_HANDLE_CONFIRM',
      batchId,
      urlIndex,
      attempt,
      url: url || '',
      aiContent: aiContent || '',
      result: 'skipped',
      errorCode: null,
      errorMessage: 'already_commented'
    });
  }

  const MANUAL_REQUIRED_MESSAGE = '检测到验证码/反垃圾验证，请手动填写后提交';
  const GENERATED_MANUAL_MESSAGE =
    '评论已生成但未自动提交，请从批次控制台进入人工处理';
  const MANUAL_REQUIRED_KEYWORDS = [
    'captcha',
    'aiowps-captcha',
    'captcha-answer',
    'anti-spam',
    'antispam',
    'spam',
    'verification',
    'verify',
    'human',
    'robot',
    'answer in digits',
    'enter an answer',
    'answer:',
    'math',
    'equation',
    'security question',
    '验证码',
    '反垃圾',
    '验证'
  ];
  const MANUAL_REQUIRED_WIDGET_SELECTORS = [
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
    '[data-sitekey]',
    '[name="g-recaptcha-response"]',
    '[name="h-captcha-response"]',
    '[name="cf-turnstile-response"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[title*="reCAPTCHA"]',
    'iframe[title*="captcha"]'
  ];

  function detectManualRequiredChallenge(form) {
    const targetForm = form || findCommentForm();
    if (!targetForm) return { found: false };

    const widget = findManualRequiredWidget(targetForm);
    if (widget) {
      console.log('[AutoComment] 检测到需手动处理的人机验证组件:', {
        tag: widget.tagName,
        className: widget.className,
        src: widget.getAttribute && widget.getAttribute('src'),
        title: widget.getAttribute && widget.getAttribute('title')
      });
      return { found: true, field: widget, message: MANUAL_REQUIRED_MESSAGE };
    }

    const candidateFields = Array.from(targetForm.querySelectorAll('input, textarea, select'))
      .filter((field) => isEmptyField(field) && isVisibleFormField(field));

    for (const field of candidateFields) {
      const text = getFieldContextText(field, targetForm).toLowerCase();
      const isRequiredManualField =
        isRequiredField(field) ||
        isLikelyManualChallengeField(field, targetForm, text);
      if (isRequiredManualField && MANUAL_REQUIRED_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()))) {
        console.log('[AutoComment] 检测到需手动处理的验证/反垃圾字段:', {
          name: field.name,
          id: field.id,
          type: field.type,
          placeholder: field.placeholder,
          context: text.slice(0, 180)
        });
        return { found: true, field, message: MANUAL_REQUIRED_MESSAGE };
      }
    }

    return { found: false };
  }

  function findManualRequiredWidget(root) {
    for (const selector of MANUAL_REQUIRED_WIDGET_SELECTORS) {
      try {
        const node = root.querySelector(selector);
        if (node) return node;
      } catch (_) {}
    }
    return null;
  }

  function isLikelyManualChallengeField(field, form, contextText) {
    const name = (field.name || '').toLowerCase();
    const id = (field.id || '').toLowerCase();
    const className = (field.className || '').toLowerCase();
    const type = (field.type || '').toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button') return false;

    const text = `${name} ${id} ${className} ${contextText || ''}`;
    if (text.includes('aiowps-captcha') || text.includes('captcha-answer')) return true;
    if (text.includes('answer in digits') || text.includes('enter an answer')) return true;
    if (text.includes('equation') && (text.includes('captcha') || text.includes('='))) return true;

    const container = field.closest && field.closest('p, div, label, section');
    const containerText = ((container && container.textContent) || '').toLowerCase();
    return (
      containerText.includes('please enter an answer in digits') ||
      (containerText.includes('captcha') && containerText.includes('answer')) ||
      (containerText.includes('=') && containerText.includes('answer'))
    );
  }

  function isRequiredField(field) {
    return !!(field && (field.required || field.getAttribute('aria-required') === 'true'));
  }

  function isEmptyField(field) {
    if (!field) return false;
    const tag = (field.tagName || '').toLowerCase();
    const type = (field.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return !field.checked;
    if (tag === 'select') return !field.value;
    return !(field.value || '').trim();
  }

  function isVisibleFormField(field) {
    if (!field || field.disabled) return false;
    const type = (field.type || '').toLowerCase();
    if (type === 'hidden') return false;
    const style = window.getComputedStyle(field);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function getFieldContextText(field, form) {
    const parts = [
      field.name,
      field.id,
      field.className,
      field.type,
      field.placeholder,
      field.getAttribute('aria-label'),
      field.getAttribute('title'),
      field.getAttribute('autocomplete')
    ];

    if (field.id && typeof CSS !== 'undefined' && CSS.escape) {
      try {
        const label = form.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) parts.push(label.textContent);
      } catch (_) {}
    }

    const closestLabel = field.closest && field.closest('label');
    if (closestLabel) parts.push(closestLabel.textContent);

    const previous = field.previousElementSibling;
    if (previous && (previous.textContent || '').length < 120) parts.push(previous.textContent);

    const next = field.nextElementSibling;
    if (next && (next.textContent || '').length < 120) parts.push(next.textContent);

    return parts.filter(Boolean).join(' ');
  }

  async function reportManualRequiredAndClose(
    batchId,
    urlIndex,
    attempt,
    url,
    aiContent
  ) {
    console.log('[content] 检测到需手动处理，上报 manual_required 并关闭网页:', {
      batchId,
      urlIndex
    });
    await writePendingResult(
      batchId,
      urlIndex,
      attempt,
      url,
      'manual_required',
      aiContent || null,
      MANUAL_REQUIRED_MESSAGE,
      'submission_uncertain'
    );

    await confirmBatchHistoryDurably({
      type: 'BATCH_HANDLE_CONFIRM',
      batchId,
      urlIndex,
      attempt,
      url: url || '',
      aiContent: aiContent || '',
      result: 'manual_required',
      errorCode: 'submission_uncertain',
      errorMessage: MANUAL_REQUIRED_MESSAGE
    });

    setTimeout(() => {
      window.close();
    }, 500);
  }

  async function reportGeneratedCommentForManualHandling(
    context,
    aiContent,
    history,
    {
      errorCode = 'auto_submit_disabled',
      errorMessage = GENERATED_MANUAL_MESSAGE
    } = {}
  ) {
    await writePendingResult(
      context.batchId,
      context.urlIndex,
      context.attempt,
      context.url,
      'manual_required',
      aiContent || null,
      errorMessage,
      errorCode
    );
    await confirmBatchHistoryDurably({
      type: 'BATCH_HANDLE_CONFIRM',
      batchId: context.batchId,
      urlIndex: context.urlIndex,
      attempt: context.attempt,
      url: context.url || '',
      aiContent: aiContent || '',
      result: 'manual_required',
      errorCode,
      errorMessage,
      resultPreview: history
        ? {
            commentText: history.commentText,
            anchors: history.anchors,
            promotedWebsiteUrl: history.promotedWebsiteUrl
          }
        : undefined
    });
  }

  /**
   * 将待确认结果写入 storage（页面刷新前同步落盘，batch.js 轮询可立即读到）
   */
  async function writePendingResult(
    batchId,
    urlIndex,
    attempt,
    url,
    result,
    aiContent,
    errorMessage,
    errorCode
  ) {
    console.log('[content] writePendingResult >>>', {
      batchId,
      urlIndex,
      attempt,
      result,
      aiContentLength: aiContent ? aiContent.length : 0,
      hasError: Boolean(errorMessage),
      errorCode
    });
    const delivery = await sendProvenBatchMessage({
      type: 'BATCH_PERSIST_PENDING_RESULT',
      batchId,
      urlIndex,
      attempt,
      url: url || '',
      result,
      aiContent,
      errorMessage,
      errorCode
    });
    const response = delivery.response;
    if (!response?.ok) {
      const error = new Error(
        delivery.transportExhausted
          ? 'batch_transport_exhausted'
          : response?.error || '批处理待确认结果保存失败'
      );
      error.code = delivery.transportExhausted
        ? 'batch_transport_exhausted'
        : response?.error;
      throw error;
    }
    console.log('[content] writePendingResult <<< 写入完成');
  }

  async function reportBatchResult(
    batchId,
    urlIndex,
    attempt,
    result,
    aiContent,
    errorMessage,
    pageUrl,
    errorCode
  ) {
    const payload = {
      type: 'BATCH_REPORT_RESULT',
      batchId,
      urlIndex,
      attempt,
      url: pageUrl || '',
      result,
      aiContent,
      errorMessage,
      errorCode
    };

    const delivery = await sendProvenBatchMessage(payload);
    if (delivery.response?.ok === true) {
      return delivery.response;
    }
    if (delivery.transportExhausted) {
      return {
        ok: false,
        error: 'batch_transport_exhausted',
        retryable: true
      };
    }
    return delivery.response || {
      ok: false,
      error: 'batch_report_rejected'
    };
  }
})();
