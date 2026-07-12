/** Minimal shim for piexifjs (dev/test-only: builds the GPS-tagged EXIF fixture). */
declare module "piexifjs" {
  const piexif: {
    dump(exifObj: Record<string, unknown>): string;
    insert(exifBytes: string, jpegDataUrlOrBinary: string): string;
    load(jpegDataUrlOrBinary: string): Record<string, Record<number, unknown>>;
    GPSIFD: {
      GPSLatitudeRef: number;
      GPSLatitude: number;
      GPSLongitudeRef: number;
      GPSLongitude: number;
    } & Record<string, number>;
    ExifIFD: Record<string, number>;
    ImageIFD: Record<string, number>;
  };
  export default piexif;
}
