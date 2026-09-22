// A small, hand-built schedule used to drive the real app's update() loop
// deterministically. Mirrors the exact classFocusData shape documented in
// README.md's "資料存在哪裡、存了什麼" table.
export function buildFixtureData() {
  return {
    teacherDB: {
      A: ['數學', '王老師', ''],
      B: ['國文/公民', '李老師/陳老師', ''],
      C: ['英文', '林老師', '']
    },
    teacherOrder: ['A', 'B', 'C'],
    locationDB: {
      A: '101',
      B: '102',
      C: '103'
    },
    weeklySchedule: {
      0: [],
      1: ['A', 'B', 'C'],
      2: [],
      3: ['A', '', ''],
      4: [],
      5: [],
      6: []
    },
    bellTimes: [
      ['08:00', '08:50'],
      ['09:10', '10:00'],
      ['10:10', '11:00']
    ],
    // Left empty deliberately: sanitizeBreakTimes() auto-merges in any
    // DEFAULT_BREAK_TIMES entry that fits without conflict, and 打掃時間
    // (08:50-09:10) fits exactly between period 0 and period 1 above.
    breakTimes: [],
    countdownEvents: [{ name: '第一次段考', startDate: '2024-01-15', endDate: '2024-01-17' }],
    reverseWeek: false,
    proAccent: '#0A84FF',
    proSecondary: '#5856D6',
    styleSlots: []
  };
}

export function seedLocalStorage(overrides = {}) {
  const data = { ...buildFixtureData(), ...overrides };
  localStorage.setItem('classFocusData', JSON.stringify(data));
  return data;
}
