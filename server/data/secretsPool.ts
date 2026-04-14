export interface SecretTemplate {
  /** Unique identifier for this template */
  id: string;
  /** Category: medical | financial | witness | romantic | past | suspicion */
  category: 'medical' | 'financial' | 'witness' | 'romantic' | 'past' | 'suspicion';
  /**
   * Parameterized template string.
   * Use {subject} for the secret holder, {target} for a second agent if relevant.
   */
  template: string;
  /** 1 = public knowledge, 2 = private, 3 = deeply secret */
  sensitivity: 1 | 2 | 3;
}

export const SECRETS_POOL: SecretTemplate[] = [
  // ─── medical (3) ─────────────────────────────────────────────────────────────
  {
    id: 'medical_chronic_illness',
    category: 'medical',
    template: '{subject} has been hiding a chronic illness from everyone in town.',
    sensitivity: 3,
  },
  {
    id: 'medical_addiction',
    category: 'medical',
    template: '{subject} has been quietly dependent on a substance for months.',
    sensitivity: 3,
  },
  {
    id: 'medical_mental_health',
    category: 'medical',
    template: '{subject} has been struggling with their mental health and hasn\'t told anyone.',
    sensitivity: 3,
  },

  // ─── financial (3) ───────────────────────────────────────────────────────────
  {
    id: 'financial_deep_debt',
    category: 'financial',
    template: '{subject} owes a large sum of money and is desperate to keep it quiet.',
    sensitivity: 2,
  },
  {
    id: 'financial_theft',
    category: 'financial',
    template: '{subject} was caught stealing from the town supply, but it was hushed up.',
    sensitivity: 3,
  },
  {
    id: 'financial_bankruptcy',
    category: 'financial',
    template: '{subject}\'s business is on the verge of collapse — they\'re nearly bankrupt.',
    sensitivity: 2,
  },

  // ─── witness (4) ─────────────────────────────────────────────────────────────
  {
    id: 'witness_crime',
    category: 'witness',
    template: '{subject} witnessed {target} doing something deeply wrong and said nothing.',
    sensitivity: 3,
  },
  {
    id: 'witness_affair',
    category: 'witness',
    template: '{subject} saw {target} sneaking out of someone else\'s home late at night.',
    sensitivity: 2,
  },
  {
    id: 'witness_accident',
    category: 'witness',
    template: '{subject} saw what really caused the accident last season, but stayed silent.',
    sensitivity: 3,
  },
  {
    id: 'witness_secret_meeting',
    category: 'witness',
    template: '{subject} spotted {target} at a secret meeting they weren\'t supposed to attend.',
    sensitivity: 2,
  },

  // ─── romantic (4) ────────────────────────────────────────────────────────────
  {
    id: 'romantic_unrequited',
    category: 'romantic',
    template: '{subject} is deeply in love with {target} but has never said a word.',
    sensitivity: 2,
  },
  {
    id: 'romantic_past_relationship',
    category: 'romantic',
    template: '{subject} and {target} were once together — and it ended badly.',
    sensitivity: 2,
  },
  {
    id: 'romantic_secret_affair',
    category: 'romantic',
    template: '{subject} has been secretly meeting {target} behind closed doors.',
    sensitivity: 3,
  },
  {
    id: 'romantic_jealousy',
    category: 'romantic',
    template: '{subject} is consumed with jealousy over {target}\'s happiness.',
    sensitivity: 2,
  },

  // ─── past (3) ────────────────────────────────────────────────────────────────
  {
    id: 'past_false_identity',
    category: 'past',
    template: '{subject} is not who they claim to be — they fled here to escape their old life.',
    sensitivity: 3,
  },
  {
    id: 'past_criminal_record',
    category: 'past',
    template: '{subject} has a criminal record from before they arrived in town.',
    sensitivity: 3,
  },
  {
    id: 'past_betrayal',
    category: 'past',
    template: '{subject} once betrayed someone close to them and has never forgiven themselves.',
    sensitivity: 2,
  },

  // ─── suspicion (3) ───────────────────────────────────────────────────────────
  {
    id: 'suspicion_sabotage',
    category: 'suspicion',
    template: 'Rumor has it {subject} sabotaged {target}\'s work out of jealousy.',
    sensitivity: 1,
  },
  {
    id: 'suspicion_informant',
    category: 'suspicion',
    template: 'Some people think {subject} has been reporting on others to gain favor.',
    sensitivity: 1,
  },
  {
    id: 'suspicion_hiding_something',
    category: 'suspicion',
    template: '{subject} has been acting strangely — everyone notices, nobody knows why.',
    sensitivity: 1,
  },
];
