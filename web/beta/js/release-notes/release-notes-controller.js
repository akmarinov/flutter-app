(function (global) {
  "use strict";

  const TAHtml = global.TAHtml;
  const utils = TAHtml.utils;

  const releaseNotesDataPath = "./js/release-notes/release-notes-data.js";
  let releaseNotesDataPromise = null;

  function loadReleaseNotesData() {
    if (TAHtml.releaseNotesData) {
      return Promise.resolve(TAHtml.releaseNotesData);
    }
    if (releaseNotesDataPromise) {
      return releaseNotesDataPromise;
    }

    releaseNotesDataPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = releaseNotesDataPath;
      script.async = true;
      script.onload = () => {
        if (TAHtml.releaseNotesData) {
          resolve(TAHtml.releaseNotesData);
          return;
        }
        releaseNotesDataPromise = null;
        reject(new Error("release notes data did not register"));
      };
      script.onerror = () => {
        releaseNotesDataPromise = null;
        reject(new Error("failed to load " + releaseNotesDataPath));
      };
      document.head.appendChild(script);
    });

    return releaseNotesDataPromise;
  }

  class ReleaseNotesController {
    constructor(options) {
      this.versionsContainer = options.versionsContainer;
      this.detailsContainer = options.detailsContainer;

      // The changelog is a 57 KB data file that is only needed once the release
      // notes page is opened, so it is injected on first render.
      this.releaseNotes = TAHtml.releaseNotesData || null;
      this.selectedVersion = null;
      this.selectedItem = null;
      this._dataLoadPromise = null;

      if (this.releaseNotes) {
        this._selectFirstEntry();
      }
    }

    render() {
      if (this.releaseNotes) {
        this._renderNow();
        return;
      }

      this._ensureDataLoaded().then(
        () => {
          this._renderNow();
        },
        (error) => {
          TAHtml.log("Unable to load release notes data: " + String(error));
        },
      );
    }

    _renderNow() {
      if (!this.releaseNotes || !this.selectedItem) {
        return;
      }
      this._renderVersions();
      this._renderDetails();
    }

    _ensureDataLoaded() {
      if (this.releaseNotes) {
        return Promise.resolve(this.releaseNotes);
      }
      if (!this._dataLoadPromise) {
        this._dataLoadPromise = loadReleaseNotesData().then(
          (data) => {
            this.releaseNotes = data;
            this._selectFirstEntry();
            return data;
          },
          (error) => {
            // Allow a later visit to the page to retry after a transient failure.
            this._dataLoadPromise = null;
            throw error;
          },
        );
      }
      return this._dataLoadPromise;
    }

    _selectFirstEntry() {
      const versions = (this.releaseNotes && this.releaseNotes.versions) || [];
      if (versions.length === 0) {
        return;
      }
      this.selectedVersion = versions[0];
      this.selectedItem = this.selectedVersion.changelogItems[0];
    }

    _renderVersions() {
      this.versionsContainer.innerHTML = "";

      const versions = this.releaseNotes.versions;
      for (let versionIndex = 0; versionIndex < versions.length; versionIndex += 1) {
        const version = versions[versionIndex];

        const versionTitle = utils.createElement(
          "div",
          "release-version-title",
          version.versionName,
        );
        this.versionsContainer.appendChild(versionTitle);

        for (let itemIndex = 0; itemIndex < version.changelogItems.length; itemIndex += 1) {
          const item = version.changelogItems[itemIndex];
          const card = utils.createElement("button", "release-card", null);
          card.type = "button";
          if (item === this.selectedItem) {
            card.classList.add("active");
          }

          const cardTitle = utils.createElement("div", "release-card-title", item.title);
          const cardSubtitle = utils.createElement(
            "div",
            "release-card-subtitle",
            item.shortDescription,
          );

          card.appendChild(cardTitle);
          card.appendChild(cardSubtitle);

          card.addEventListener("click", () => {
            this.selectedVersion = version;
            this.selectedItem = item;
            this.render();
          });

          this.versionsContainer.appendChild(card);
        }
      }
    }

    _renderDetails() {
      this.detailsContainer.innerHTML = "";
      const detailsText = utils.createElement(
        "div",
        "release-details-text",
        this.selectedItem.descriptionMarkdown,
      );
      this.detailsContainer.appendChild(detailsText);
    }
  }

  TAHtml.ReleaseNotesController = ReleaseNotesController;
})(window);
