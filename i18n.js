// Lightweight i18n: Arabic default, English toggle, saved in localStorage.

const LANG_KEY = "kfs_lang";

const translations = {
  ar: {
    app_name: "KFS Padel Ranking",
    loading: "جاري التحميل...",
    tab_home: "الرئيسية",
    tab_market: "المتجر",
    tab_leaderboard: "الترتيب",
    tab_profile: "البروفايل",
    // login
    login_title: "سجّل دخولك",
    login_sub: "استخدم الكود والباسورد اللي اداهولك الأدمن.",
    login_code_label: "كود اللاعب",
    login_pass_label: "الباسورد",
    login_btn: "دخول",
    login_signing_in: "جاري الدخول...",
    login_no_code: "مفيش عندك كود؟ كلم الأدمن في نادي KFS",
    login_err_no_code: "الكود ده مش موجود. اتأكد منه وحاول تاني.",
    login_err_wrong_pass: "الباسورد غلط. حاول تاني.",
    login_err_generic: "حصل خطأ في الاتصال. حاول تاني.",
    // home
    home_greeting_prefix: "أهلاً",
    home_sub: "لمحة سريعة عن حالتك في KFS Padel.",
    home_your_rank: "ترتيبك في الليدربورد",
    home_tournaments_title: "البطولات",
    home_top_players_title: "أفضل اللاعبين",
    view_all: "عرض الكل",
    pts: "نقطة",
    of: "من",
    // tournaments
    tournaments_title: "البطولات",
    tournaments_sub: "شوف نتايج البطولات القديمة وسجل في الجايه.",
    tournaments_empty: "لسه مفيش بطولات مضافة.",
    status_live: "لايف",
    status_upcoming: "قريبًا",
    status_completed: "خلصت",
    register_btn: "سجل",
    registering: "جاري التسجيل...",
    registered_btn: "متسجل ✓",
    champion_label: "البطل",
    // leaderboard
    leaderboard_title: "الترتيب العام",
    leaderboard_sub: "ترتيب كل لاعيبة KFS حسب النقط.",
    your_rank: "ترتيبك",
    you_suffix: "(انت)",
    leaderboard_err: "حصل خطأ في تحميل الترتيب.",
    // marketplace
    marketplace_badge: "قريبًا",
    marketplace_title: "Marketplace",
    marketplace_sub: "هتقدر قريبًا تشتري أكواد مميزة، معدات بادل، وحجوزات مباشرة من هنا. تابعنا.",
    // profile
    profile_matches: "ماتش",
    profile_wins: "فوز",
    profile_losses: "خسارة",
    profile_change_photo: "تغيير الصورة",
    profile_member_since: "عضو من",
    // settings
    settings_title: "الإعدادات",
    settings_sub: "بيانات حسابك واللغة.",
    settings_language: "اللغة",
    settings_lang_ar: "العربية",
    settings_lang_en: "English",
    settings_change_pass: "تغيير الباسورد",
    settings_current_pass: "الباسورد الحالي",
    settings_new_pass: "الباسورد الجديد",
    settings_confirm_pass: "تأكيد الباسورد الجديد",
    settings_save_pass: "حفظ الباسورد الجديد",
    settings_saving: "جاري الحفظ...",
    settings_logout: "تسجيل الخروج",
    pass_err_mismatch: "الباسورد الجديد وتأكيده مش متطابقين.",
    pass_err_short: "الباسورد الجديد لازم يكون 6 حروف أو أرقام على الأقل.",
    pass_err_wrong_current: "الباسورد الحالي غلط.",
    pass_success: "تم تغيير الباسورد بنجاح.",
    pass_err_generic: "حصل خطأ، حاول تاني.",
    back: "رجوع"
  },
  en: {
    app_name: "KFS Padel Ranking",
    loading: "Loading...",
    tab_home: "Home",
    tab_market: "Market",
    tab_leaderboard: "Leaderboard",
    tab_profile: "Profile",
    login_title: "Sign in to your profile",
    login_sub: "Use the code and password your admin gave you.",
    login_code_label: "Player code",
    login_pass_label: "Password",
    login_btn: "Sign in",
    login_signing_in: "Signing in...",
    login_no_code: "No code yet? Ask the admin at KFS club.",
    login_err_no_code: "That code doesn't exist. Double-check it and try again.",
    login_err_wrong_pass: "Wrong password. Try again.",
    login_err_generic: "Something went wrong. Try again.",
    home_greeting_prefix: "Hi",
    home_sub: "A quick look at where you stand in KFS Padel.",
    home_your_rank: "Your leaderboard rank",
    home_tournaments_title: "Tournaments",
    home_top_players_title: "Top Players",
    view_all: "View all",
    pts: "pts",
    of: "of",
    tournaments_title: "Tournaments",
    tournaments_sub: "Browse past results and register for what's coming up.",
    tournaments_empty: "No tournaments have been added yet.",
    status_live: "Live",
    status_upcoming: "Upcoming",
    status_completed: "Completed",
    register_btn: "Register",
    registering: "Registering...",
    registered_btn: "Registered ✓",
    champion_label: "Champion",
    leaderboard_title: "Leaderboard",
    leaderboard_sub: "Every KFS player, ranked by rating points.",
    your_rank: "Your rank",
    you_suffix: "(you)",
    leaderboard_err: "Couldn't load the leaderboard.",
    marketplace_badge: "Coming soon",
    marketplace_title: "Marketplace",
    marketplace_sub: "Soon you'll be able to buy custom codes, padel gear, and book courts directly from here. Stay tuned.",
    profile_matches: "Matches",
    profile_wins: "Wins",
    profile_losses: "Losses",
    profile_change_photo: "Change photo",
    profile_member_since: "Member since",
    settings_title: "Settings",
    settings_sub: "Your account and language.",
    settings_language: "Language",
    settings_lang_ar: "العربية",
    settings_lang_en: "English",
    settings_change_pass: "Change password",
    settings_current_pass: "Current password",
    settings_new_pass: "New password",
    settings_confirm_pass: "Confirm new password",
    settings_save_pass: "Save new password",
    settings_saving: "Saving...",
    settings_logout: "Log out",
    pass_err_mismatch: "New password and confirmation don't match.",
    pass_err_short: "New password must be at least 6 characters.",
    pass_err_wrong_current: "Current password is wrong.",
    pass_success: "Password changed successfully.",
    pass_err_generic: "Something went wrong. Try again.",
    back: "Back"
  }
};

export function getLang() {
  return localStorage.getItem(LANG_KEY) || "ar";
}

export function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang);
}

export function t(key) {
  const lang = getLang();
  return (translations[lang] && translations[lang][key]) || translations.en[key] || key;
}

// Applies dir/lang on <html> and fills every [data-i18n] / [data-i18n-placeholder] element.
export function applyStaticTranslations() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}
