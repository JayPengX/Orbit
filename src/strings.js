// ---- src/strings.js ----
// A lookup table for UI strings, starting with zh-TW only (the app's only
// current language) - populated 1:1 from the literals that used to be
// inline. This doesn't add a second language; it turns "add one later"
// into filling in another locale object here instead of hunting through
// every module for embedded Chinese text.
//
// Not every string in the app has been migrated here yet - this covers the
// dashboard's status/countdown labels (schedule-calc.js) as a worked
// example of the convention. Extend it the same way: add the key under
// `zh-TW`, call `t('the.key')` where the literal used to be.
const STRINGS = {
  'zh-TW': {
    'dashboard.notStarted': '尚未開始',
    'dashboard.schoolOver': '放學時間',
    'dashboard.noSchoolToday': '今日無課',
    'dashboard.betweenClasses': '下課',
    'dashboard.duringClass': '上課',
    'dashboard.seeYouWeekend': '週末愉快',
    'dashboard.seeYouTomorrow': '再見',
    'dashboard.seeYouMonday': '週一見',
    'dashboard.loading': '載入中…',
    'nlEdit.notConfigured': 'AI 課表編輯功能尚未設定，請聯絡課表管理者。',
    'nlEdit.offline': '目前沒有網路連線，AI 課表編輯暫時無法使用。',
    'nlEdit.viewerLocked': '此裝置為僅接收模式，無法使用 AI 課表編輯。如要自行編輯，請先解除同步。',
    'nlEdit.emptyInput': '請先輸入想修改的內容。',
    'nlEdit.working': '正在請求 AI 解析指令…',
    'nlEdit.ready': 'AI 已提出修改建議，請確認後套用。',
    'nlEdit.badResponse': 'AI 沒有回傳可辨識的修改建議，請換個說法再試。',
    'nlEdit.unclearTitle': '看不懂這個指令',
    'nlEdit.unclearMessage': 'AI 無法判斷這句話對應到哪一個修改動作，請換個說法再試。',
    'nlEdit.notFoundTitle': '找不到對應的課程或節次',
    'nlEdit.notFoundMessage': 'AI 判斷這個指令提到的星期、節次或課程在目前課表中不存在。',
    'nlEdit.noChangeTitle': '沒有變更',
    'nlEdit.noChangeMessage': 'AI 提出的修改內容跟目前課表完全相同，沒有需要套用的變更。',
    'nlEdit.confirmTitle': '要套用 AI 建議的修改嗎？',
    'nlEdit.confirmMessage': '會套用以下變更。',
    'nlEdit.confirmApply': '套用',
    'nlEdit.confirmCancel': '取消',
    'nlEdit.dismiss': '知道了'
  }
};

// No locale switcher exists yet (there's only one locale) - this stays a
// plain constant until a second locale and a way to choose it are added,
// at which point it becomes a mutable value with a setter alongside it.
const currentLocale = 'zh-TW';

/**
 * Looks up a UI string by key in the current locale, falling back to zh-TW
 * (and then the key itself) if a locale is ever added that's missing one.
 */
function t(key) {
  return STRINGS[currentLocale]?.[key] ?? STRINGS['zh-TW'][key] ?? key;
}

export { t };
