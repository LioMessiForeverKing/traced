export const CAPABILITIES = {
  Read: { ReadCategories: true },
  Store: {
    StoreBookmarks: true,
    StoreRejectedContent: true,
    StoreUserIDKey: true,
    StoreSignedVideo: false,
    StoreGNSSTrackRecording: true,
  },
  StoreAndRead: { StoreReadSystemID: true },
};

export const CATEGORIES = [
  { Name: "Incident", Id: "incident" },
  { Name: "Inspection", Id: "inspection" },
  { Name: "Defect", Id: "defect" },
  { Name: "Safety concern", Id: "safety" },
  { Name: "Handover", Id: "handover" },
];
