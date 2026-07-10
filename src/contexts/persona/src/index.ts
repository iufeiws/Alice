export type PersonaOption = {
  id: string;
  name: string;
  content: string;
  group?: string;
};

export type PersonaSnapshot = {
  date: string;
  createdAt: string;
  persona: PersonaOption;
  relationship: PersonaOption;
};
