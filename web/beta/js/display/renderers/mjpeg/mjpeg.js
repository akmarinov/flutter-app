var img = document.getElementById("image");
var canvas = document.getElementById("canvas");
var urlCreator = window.URL || window.webkitURL;

// Decoding to a bitmap and blitting it ourselves keeps at most one JPEG decode in
// flight: the <img> path queues every frame the browser has not painted yet.
var bitmapContext =
    typeof createImageBitmap === "function" ? canvas.getContext("2d", { alpha: false }) : null;
var decoding = false;
var pendingBlob = null;
var currentImageUrl;
var decodeFailures = 0;

img.style.display = bitmapContext ? "none" : "block";
canvas.style.display = bitmapContext ? "block" : "none";

function drawDisplayFrame(blob) {
    if (!blob) {
        return;
    }

    if (!bitmapContext) {
        drawFrameWithObjectUrl(blob);
        return;
    }

    if (decoding) {
        pendingBlob = blob;
        return;
    }

    decoding = true;
    createImageBitmap(blob).then(function (bitmap) {
        decodeFailures = 0;
        if (bitmap.width !== canvas.width || bitmap.height !== canvas.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
        }
        bitmapContext.drawImage(bitmap, 0, 0);
        if (typeof bitmap.close === "function") {
            bitmap.close();
        }
        frameFinished();
    }, function () {
        // Older engines can reject or mis-handle bitmap decoding; after a few
        // consecutive failures go back to the <img> path instead of going black.
        decodeFailures += 1;
        if (decodeFailures >= 3) {
            bitmapContext = null;
            img.style.display = "block";
            canvas.style.display = "none";
        }
        frameFinished();
    });
}

function frameFinished() {
    decoding = false;
    var next = pendingBlob;
    pendingBlob = null;
    if (next) {
        drawDisplayFrame(next);
    }
}

function drawFrameWithObjectUrl(blob) {
    if (currentImageUrl) {
        urlCreator.revokeObjectURL(currentImageUrl);
    }

    let imageUrl = urlCreator.createObjectURL(blob);
    currentImageUrl = imageUrl;

    img.src = imageUrl;
}
