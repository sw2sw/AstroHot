// Pure ESA image identity and licence checks shared by analysis and the read-only DTO.
export const ESA_IMAGE_LICENSES = [
  { license: "ESA Standard Licence", licenseUrl: "https://www.esa.int/ESA_Multimedia/Terms_and_conditions_of_use_of_images_and_videos_available_on_the_esa_website" },
] as const;

export function esaImageIdentity(url: unknown): { attributionUrl: string; storage: string; canonicalUrl: string } | null {
  if (typeof url !== "string") return null;
  const image = /^https:\/\/www\.esa\.int\/var\/esa\/storage\/images\/(?:esa_multimedia\/images\/)?([0-9]{4})\/(0[1-9]|1[0-2])\/([a-z0-9]+(?:_[a-z0-9]+)*)\/([0-9]+-[0-9]+-eng-GB)\/([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?)(?:_article|_pillars|_card_full)?\.(jpg|png)$/.exec(url);
  if (!image || image[0] !== url || image[3] !== image[5].toLowerCase()) return null;
  const storage = `/var/esa/storage/images/esa_multimedia/images/${image[1]}/${image[2]}/${image[3]}/${image[4]}/${image[5]}`;
  return { attributionUrl: `https://www.esa.int/ESA_Multimedia/Images/${image[1]}/${image[2]}/${image[5]}`, storage, canonicalUrl: `https://www.esa.int${storage}.${image[6]}` };
}
