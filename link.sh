echo "Recreating ${MILA_BASE_PATH}/node_modules/@centipod"

rm -rf "${MILA_BASE_PATH}/node_modules/@centipod"
mkdir "${MILA_BASE_PATH}/node_modules/@centipod"


echo "Copying compiled files to ${MILA_BASE_PATH}/node_modules/@centipod"

cp -R ./cli "${MILA_BASE_PATH}/node_modules/@centipod"
cp -R ./core "${MILA_BASE_PATH}/node_modules/@centipod"
